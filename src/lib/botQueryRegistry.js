/**
 * botQueryRegistry.js — Whitelisted parameterized queries the help-bot can run.
 *
 * Why a registry: SQL execution from a chatbot must be hard-locked. We never
 * accept generated/templated SQL. Every query lives here, is parameterized
 * with $1 = agency_id (mandatory), and declares its required permission.
 *
 * The /ask handler:
 *   1. Matches a bot_knowledge entry whose query_type points to a key here
 *   2. Verifies user has the declared permission (via DEFAULT_PERMISSIONS)
 *   3. Runs the SQL with [agency_id, ...extraParams] — never any user-provided string
 *   4. Calls render() to substitute results into the answer template
 *
 * To add a new live-data Q&A:
 *   1. Add a key+def here
 *   2. Insert a bot_knowledge row with that key in `query_type`
 *
 * NEVER inline user input into the SQL. NEVER select * (audit-able columns only).
 */

const PIPELINE_LABELS = {
  VISITOR: "ভিজিটর", FOLLOW_UP: "ফলো-আপ", ENROLLED: "ভর্তি", IN_COURSE: "কোর্সে",
  EXAM_PASSED: "পরীক্ষায় পাশ", DOC_COLLECTION: "ডকুমেন্ট সংগ্রহ", SCHOOL_INTERVIEW: "ইন্টারভিউ",
  DOC_SUBMITTED: "ডকুমেন্ট জমা", COE_RECEIVED: "COE পেয়েছে", VISA_GRANTED: "ভিসা পেয়েছে",
  ARRIVED: "জাপান পৌঁছেছে", COMPLETED: "সম্পন্ন", CANCELLED: "বাতিল", PAUSED: "বিরতি",
};

const REGISTRY = {
  count_students_active: {
    permission: "students:read",
    sql: `SELECT count(*)::int AS n
            FROM students
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL
             AND status NOT IN ('CANCELLED', 'COMPLETED')`,
    render: (rows, tpl) => tpl.replace(/\{count\}/g, String(rows[0]?.n ?? 0)),
  },

  count_visitors_today: {
    permission: "visitors:read",
    sql: `SELECT count(*)::int AS n
            FROM visitors
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL
             AND created_at >= date_trunc('day', now())`,
    render: (rows, tpl) => tpl.replace(/\{count\}/g, String(rows[0]?.n ?? 0)),
  },

  count_visitors_this_month: {
    permission: "visitors:read",
    sql: `SELECT count(*)::int AS n
            FROM visitors
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL
             AND created_at >= date_trunc('month', now())`,
    render: (rows, tpl) => tpl.replace(/\{count\}/g, String(rows[0]?.n ?? 0)),
  },

  count_students_by_status: {
    permission: "students:read",
    sql: `SELECT status, count(*)::int AS n
            FROM students
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL
           GROUP BY status
           ORDER BY n DESC`,
    render: (rows, tpl) => {
      if (!rows.length) return tpl.replace(/\{breakdown\}/g, "_কোনো student নেই_");
      const lines = rows.map(r => `• ${PIPELINE_LABELS[r.status] || r.status}: **${r.n}**`).join("\n");
      return tpl.replace(/\{breakdown\}/g, lines);
    },
  },

  recent_visitors: {
    permission: "visitors:read",
    sql: `SELECT name, country, created_at
            FROM visitors
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL
           ORDER BY created_at DESC
           LIMIT 5`,
    render: (rows, tpl) => {
      if (!rows.length) return tpl.replace(/\{list\}/g, "_কোনো visitor নেই_");
      const lines = rows.map((r, i) => {
        const when = new Date(r.created_at).toLocaleDateString("en-GB");
        return `${i + 1}. ${r.name || "—"} (${r.country || "—"}) · ${when}`;
      }).join("\n");
      return tpl.replace(/\{list\}/g, lines);
    },
  },

  count_schools: {
    permission: "schools:read",
    sql: `SELECT count(*)::int AS n
            FROM schools
           WHERE agency_id = $1
             AND COALESCE(deleted_at, NULL) IS NULL`,
    render: (rows, tpl) => tpl.replace(/\{count\}/g, String(rows[0]?.n ?? 0)),
  },

  count_pending_invoices: {
    permission: "accounts:read",
    sql: `SELECT count(*)::int AS n
            FROM invoices
           WHERE agency_id = $1
             AND status IN ('SENT', 'OVERDUE', 'PARTIAL')`,
    render: (rows, tpl) => tpl.replace(/\{count\}/g, String(rows[0]?.n ?? 0)),
  },
};

/**
 * Run a registered query. Returns { ok, text, error }.
 * - ok=false + error='unknown_query'   → bad query_type in DB row
 * - ok=false + error='no_permission'   → user lacks the required permission
 * - ok=false + error='exec_failed'     → SQL/runtime error (already logged)
 * - ok=true  + text=rendered string    → success
 */
async function runQuery({ key, agencyId, answerTemplate, hasPermission, pool }) {
  const def = REGISTRY[key];
  if (!def) return { ok: false, error: "unknown_query" };

  if (!hasPermission(def.permission)) return { ok: false, error: "no_permission" };

  try {
    const result = await pool.query(def.sql, [agencyId]);
    const text = def.render(result.rows || [], answerTemplate);
    return { ok: true, text };
  } catch (err) {
    console.error(`[botQuery:${key}]`, err.message);
    return { ok: false, error: "exec_failed" };
  }
}

module.exports = { REGISTRY, runQuery };
