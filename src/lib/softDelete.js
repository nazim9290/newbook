/**
 * softDelete.js — Soft Delete Helpers
 *
 * deleted_at TIMESTAMPTZ column-এর উপর ভিত্তি করে soft delete API।
 * Audit trail preserve করে — physical purge শুধু retention window
 * (default 90 days) পার হলে purgeExpired() করতে পারবে।
 *
 * Usage:
 *   const sd = require("../lib/softDelete");
 *   query = sd.applyActiveFilter(query);                  // list/read এ
 *   await sd.softDeleteRow({ table, id, agencyId, ... }); // DELETE handler এ
 *   await sd.restoreRow({ table, id, agencyId, ... });    // restore route এ
 *   await sd.purgeExpired({ table, retentionDays, ... }); // cleanup job এ
 *
 * Note: helpers always include agency_id + id WHERE clauses
 * (defense in depth — route already filters, এখানেও double-check)।
 */

// সব table যেগুলো soft-delete-aware করা হয়েছে (migration_soft_delete.sql)
const SOFT_DELETE_TABLES = new Set([
  "visitors",
  "students",
  "agents",
  "schools",
  "partners",
  "employees",
  "communications",
  "documents",
  "payments",
  "batches",
  "branches",
  "holidays",
  "tasks",
  "alumni",
  "inventory",
  "broadcasts",
  "feedback",
  "calendar_events",
  "leaves",
  "attendance",
  "accounts",
]);

/**
 * নির্দিষ্ট table-টা soft-delete-aware কিনা — convenience flag
 * @param {string} tableName
 * @returns {boolean}
 */
function softDeleteTable(tableName) {
  return SOFT_DELETE_TABLES.has(tableName);
}

/**
 * Active rows filter — list/read endpoint-এ chain করো।
 * deleted_at IS NULL — soft-deleted rows বাদ যাবে।
 * @param {object} query — Supabase-compatible query builder (lib/db.js)
 * @returns {object} same builder, with .is("deleted_at", null) applied
 */
function applyActiveFilter(query) {
  if (!query || typeof query.is !== "function") return query;
  return query.is("deleted_at", null);
}

/**
 * একটি row soft-delete করো — deleted_at = now()
 * Defense in depth: agency_id + id দুটোতেই filter
 * @param {object} params
 * @param {string} params.table — table নাম (must be in SOFT_DELETE_TABLES)
 * @param {string} params.id — row id
 * @param {string} params.agencyId — tenant agency uuid
 * @param {string} [params.userId] — কে delete করল (optional, log-এর জন্য caller handle করবে)
 * @param {object} params.supabase — db client (lib/db.js)
 * @returns {Promise<{data, error}>}
 */
async function softDeleteRow({ table, id, agencyId, userId, supabase }) {
  if (!softDeleteTable(table)) {
    return { data: null, error: { message: `Table '${table}' soft-delete-aware নয়` } };
  }
  if (!id || !agencyId || !supabase) {
    return { data: null, error: { message: "id, agencyId, supabase — সব দরকার" } };
  }

  const nowIso = new Date().toISOString();
  // userId এই helper-এ schema-তে track হয় না (migration শুধু deleted_at যোগ করে);
  // caller logActivity()-এ userId পাঠাবে — এটা parameter হিসেবে accept করা হল
  // future-proofing-এর জন্য, এখন silently ignore।
  void userId;

  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: nowIso })
    .eq("id", id)
    .eq("agency_id", agencyId)
    .select()
    .single();

  return { data, error };
}

/**
 * Soft-deleted row পুনরায় active করো — deleted_at = null
 * @param {object} params
 * @param {string} params.table
 * @param {string} params.id
 * @param {string} params.agencyId
 * @param {object} params.supabase
 * @returns {Promise<{data, error}>}
 */
async function restoreRow({ table, id, agencyId, supabase }) {
  if (!softDeleteTable(table)) {
    return { data: null, error: { message: `Table '${table}' soft-delete-aware নয়` } };
  }
  if (!id || !agencyId || !supabase) {
    return { data: null, error: { message: "id, agencyId, supabase — সব দরকার" } };
  }

  const { data, error } = await supabase
    .from(table)
    .update({ deleted_at: null })
    .eq("id", id)
    .eq("agency_id", agencyId)
    .select()
    .single();

  return { data, error };
}

/**
 * Retention window পার হওয়া rows physical delete করো।
 * Cron / scheduled job থেকে call হবে (নিজে schedule করে না)।
 * @param {object} params
 * @param {string} params.table
 * @param {number} [params.retentionDays=90]
 * @param {object} params.supabase
 * @returns {Promise<{count: number, error: object|null}>}
 */
async function purgeExpired({ table, retentionDays = 90, supabase }) {
  if (!softDeleteTable(table)) {
    return { count: 0, error: { message: `Table '${table}' soft-delete-aware নয়` } };
  }
  if (!supabase || !supabase.pool) {
    return { count: 0, error: { message: "supabase pool দরকার (raw SQL)" } };
  }

  // Soft-delete-aware tables হার্ডকোড করা list থেকে আসে — SQL injection নেই।
  // retentionDays integer cast করা হল bounds-safe রাখতে।
  const days = Math.max(1, Math.floor(Number(retentionDays) || 90));

  try {
    const sql =
      `DELETE FROM "${table}" ` +
      `WHERE deleted_at IS NOT NULL ` +
      `AND deleted_at < NOW() - ($1 || ' days')::interval`;
    const result = await supabase.pool.query(sql, [String(days)]);
    return { count: result.rowCount || 0, error: null };
  } catch (err) {
    console.error("[softDelete.purgeExpired]", err.message);
    return { count: 0, error: { message: err.message } };
  }
}

module.exports = {
  softDeleteTable,
  applyActiveFilter,
  softDeleteRow,
  restoreRow,
  purgeExpired,
  SOFT_DELETE_TABLES,
};
