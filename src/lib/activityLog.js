/**
 * activityLog.js — Activity Log Helper
 *
 * সব CRUD operation-এ কে, কখন, কী করেছে সেটা log করে।
 * activity_log table-এ insert করে — async, non-blocking
 * (error হলে silently ignore করে — main operation block করে না)
 */

const supabase = require("./db");

/**
 * Activity log এ entry রাখো
 * @param {object} params
 * @param {string} params.agencyId — agency UUID
 * @param {string} params.userId — user UUID (who)
 * @param {string} params.action — "create"|"update"|"delete"|"login"|"export"
 * @param {string} params.module — "students"|"visitors"|"accounts" etc.
 * @param {string} params.recordId — affected record ID
 * @param {string} params.description — Bengali description
 * @param {object} [params.oldValue] — previous value (for update/delete)
 * @param {object} [params.newValue] — new value (for create/update)
 * @param {string} [params.ip] — client IP
 */
async function logActivity({ agencyId, userId, action, module, recordId, description, oldValue, newValue, ip }) {
  try {
    await supabase.from("activity_log").insert({
      agency_id: agencyId,
      user_id: userId,
      action,
      module,
      record_id: recordId || null,
      description: description || "",
      old_value: oldValue ? JSON.stringify(oldValue) : null,
      new_value: newValue ? JSON.stringify(newValue) : null,
      ip_address: ip || null,
    });
  } catch (err) {
    // Silently fail — log error হলেও main operation থামবে না
    console.error("[ActivityLog]", err.message);
  }
}

module.exports = { logActivity };
