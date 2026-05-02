/**
 * anomalyDetector.js — Real-time + window-based suspicious activity detection
 *
 * Two detection paths:
 *
 *   1. INLINE — called from app.js activity middleware on each
 *      successful POST/PATCH/DELETE. Cheap rules:
 *        • bulk_delete — N deletes in window
 *        • after_hours — edit between cfg.anomaly_after_hours_*
 *        • large_payment / large_refund — payment edit > threshold
 *        • fee_waiver — fee waiver > threshold
 *
 *   2. CRON — called every 30 minutes by scheduler:
 *        • failed_login — N failures in window per email
 *
 * Each trigger:
 *   - Loads matching anomaly_rules row
 *   - Checks cooldown (last_triggered_at + cooldown_minutes)
 *   - If clear, dispatch notification + insert anomaly_events row
 *   - Updates rule.last_triggered_at
 */

const supabase = require("./db");
const pool = supabase.pool;
const { dispatchToTopic } = require("./notify");

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
async function getRule(agencyId, ruleType) {
  const { rows } = await pool.query(
    `SELECT * FROM anomaly_rules WHERE agency_id = $1 AND rule_type = $2`,
    [agencyId, ruleType]
  );
  return rows[0] || null;
}

async function getSettings(agencyId) {
  const { rows } = await pool.query(
    `SELECT * FROM agency_settings WHERE agency_id = $1`, [agencyId]
  );
  return rows[0] || null;
}

async function isInCooldown(rule) {
  if (!rule.last_triggered_at) return false;
  const now = Date.now();
  const last = new Date(rule.last_triggered_at).getTime();
  const cooldownMs = (rule.cooldown_minutes || 60) * 60 * 1000;
  return now - last < cooldownMs;
}

async function recordTrigger({ agencyId, rule, actorId, details }) {
  // Insert event
  const { rows: ev } = await pool.query(`
    INSERT INTO anomaly_events (agency_id, rule_id, rule_type, triggered_by_user, details, notified)
    VALUES ($1, $2, $3, $4, $5, FALSE)
    RETURNING id
  `, [agencyId, rule.id, rule.rule_type, actorId || null, JSON.stringify(details || {})]);

  // Update rule cooldown
  await pool.query(
    `UPDATE anomaly_rules SET last_triggered_at = NOW() WHERE id = $1`,
    [rule.id]
  );

  // Dispatch notification
  let actorName = null;
  if (actorId) {
    const { rows: u } = await pool.query(
      `SELECT name, email FROM users WHERE id = $1`, [actorId]
    );
    actorName = u[0]?.name || u[0]?.email || actorId.slice(0, 8);
  }
  let agencyName = null;
  const { rows: a } = await pool.query(`SELECT name FROM agencies WHERE id = $1`, [agencyId]);
  agencyName = a[0]?.name || null;

  try {
    const dispatch = await dispatchToTopic({
      agencyId,
      topic: "anomaly",
      template: "anomaly_alert",
      data: { ruleType: rule.rule_type, actorName, details, agencyName, url: "/audit-log" },
    });
    if (dispatch.sent > 0) {
      await pool.query(`UPDATE anomaly_events SET notified = TRUE WHERE id = $1`, [ev[0].id]);
    }
  } catch (err) {
    console.error("[anomaly] dispatch failed:", err.message);
  }
  return ev[0].id;
}

// ════════════════════════════════════════════════════════════
// INLINE detection — from activity middleware
// ════════════════════════════════════════════════════════════

/**
 * Called from middleware after successful CUD response.
 * Non-blocking — errors logged, never thrown.
 */
async function inspect(req, res, data) {
  try {
    const agencyId = req.user?.agency_id;
    const userId = req.user?.id;
    if (!agencyId || !userId) return;

    const settings = await getSettings(agencyId);
    if (!settings || !settings.enable_anomaly_alerts) return;

    const method = req.method;
    const path = req.originalUrl || "";
    const module = path.replace(/\/api\//, "").split("/")[0];

    const checks = [];

    // 1. After-hours edit (any write between configured hours)
    if (method !== "GET" && settings.anomaly_after_hours_start && settings.anomaly_after_hours_end) {
      checks.push(checkAfterHours(agencyId, userId, settings, { module, method, path }));
    }

    // 2. Bulk delete — count deletes by this user in last 5 min
    if (method === "DELETE") {
      checks.push(checkBulkDelete(agencyId, userId, settings));
    }

    // 3. Large payment edit/create
    if (module === "students" && (method === "POST" || method === "PATCH") && path.includes("/payments")) {
      checks.push(checkLargePayment(agencyId, userId, settings, req.body || {}));
    }

    await Promise.all(checks);
  } catch (err) {
    console.error("[anomaly.inspect]", err.message);
  }
}

// Bulk delete — count deletes by user in last 5 min vs threshold
async function checkBulkDelete(agencyId, userId, settings) {
  const rule = await getRule(agencyId, "bulk_delete");
  if (!rule || !rule.enabled) return;

  const threshold = Math.max(1, Number(rule.threshold) || settings.anomaly_bulk_delete_threshold || 10);
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM activity_log
    WHERE agency_id = $1 AND user_id = $2 AND action = 'delete'
      AND created_at > NOW() - INTERVAL '5 minutes'
  `, [agencyId, userId]);
  const count = rows[0]?.cnt || 0;
  if (count < threshold) return;
  if (await isInCooldown(rule)) return;
  await recordTrigger({
    agencyId, rule, actorId: userId,
    details: { delete_count: count, threshold, window_minutes: 5 },
  });
}

// After-hours edit
async function checkAfterHours(agencyId, userId, settings, ctx) {
  const rule = await getRule(agencyId, "after_hours");
  if (!rule || !rule.enabled) return;

  // Dhaka time (UTC+6)
  const dhakaHour = new Date(Date.now() + 6 * 3600 * 1000).getUTCHours();
  const startH = parseInt(String(settings.anomaly_after_hours_start).split(":")[0], 10);
  const endH = parseInt(String(settings.anomaly_after_hours_end).split(":")[0], 10);

  // After-hours window crosses midnight if start > end (e.g. 23-06)
  const inWindow = startH > endH
    ? (dhakaHour >= startH || dhakaHour < endH)
    : (dhakaHour >= startH && dhakaHour < endH);
  if (!inWindow) return;

  if (await isInCooldown(rule)) return;
  await recordTrigger({
    agencyId, rule, actorId: userId,
    details: { dhaka_hour: dhakaHour, ...ctx },
  });
}

// Large payment
async function checkLargePayment(agencyId, userId, settings, body) {
  const amt = Number(body.amount || body.paid || 0);
  if (!amt) return;
  const threshold = settings.large_payment_threshold || 100000;
  if (amt < threshold) return;
  const rule = await getRule(agencyId, "large_payment");
  if (!rule || !rule.enabled) return;
  if (await isInCooldown(rule)) return;
  await recordTrigger({
    agencyId, rule, actorId: userId,
    details: { amount: amt, threshold, payment_method: body.method },
  });
}

// ════════════════════════════════════════════════════════════
// LOGIN failure tracking — called from auth.js login route
// ════════════════════════════════════════════════════════════
async function recordFailedLogin({ email, ip, userAgent }) {
  try {
    // Look up agency_id (best-effort)
    let agencyId = null;
    const { rows: u } = await pool.query(
      `SELECT agency_id FROM users WHERE email = $1 LIMIT 1`, [email]
    );
    if (u[0]) agencyId = u[0].agency_id;

    await pool.query(
      `INSERT INTO failed_login_attempts (email, ip, user_agent, agency_id) VALUES ($1, $2, $3, $4)`,
      [email, ip || null, userAgent || null, agencyId]
    );

    if (!agencyId) return;
    const settings = await getSettings(agencyId);
    if (!settings || !settings.enable_anomaly_alerts) return;
    const threshold = settings.anomaly_failed_login_threshold || 5;
    const windowMin = settings.anomaly_failed_login_window_min || 15;

    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM failed_login_attempts
      WHERE email = $1 AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
    `, [email, windowMin]);
    const count = rows[0]?.cnt || 0;
    if (count < threshold) return;

    const rule = await getRule(agencyId, "failed_login");
    if (!rule || !rule.enabled) return;
    if (await isInCooldown(rule)) return;
    await recordTrigger({
      agencyId, rule, actorId: null,
      details: { email, count, threshold, window_minutes: windowMin, ip },
    });
  } catch (err) {
    console.error("[anomaly.recordFailedLogin]", err.message);
  }
}

// ════════════════════════════════════════════════════════════
// CRON-based scan — runs every 30 min for window-based rules
// (currently a no-op; future: counselor collusion detection, etc.)
// ════════════════════════════════════════════════════════════
async function runScan() {
  // Phase 1: minimal — just clean failed_login_attempts older than 24h
  await pool.query(`DELETE FROM failed_login_attempts WHERE created_at < NOW() - INTERVAL '24 hours'`);
  return { cleaned: "old_failed_logins" };
}

module.exports = {
  inspect,
  recordFailedLogin,
  runScan,
};
