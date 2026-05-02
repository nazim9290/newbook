/**
 * quotaAlerts.js — Daily check for agencies approaching their platform-key
 * quota limits. Sends a soft warning email at 80% used; a harder one at
 * 100%. Encourages BYOK upgrade so they don't get throttled mid-month.
 *
 * Only relevant in INSTANCE_MODE=shared (enterprise installs don't use
 * platform keys, so no quota concept).
 *
 * Idempotent — uses the existing platform_settings cron-once gate via
 * scheduler.dailyOnce. Tracks per-agency-per-period last alert level so
 * an agency doesn't get spammed with the same 80% alert every day.
 */

const supabase = require("./db");
const { sendEmail } = require("./email");
const integrations = require("./integrations");

const ALERT_THRESHOLDS = [
  { pct: 100, level: 100, label: "exceeded", subject: "AgencyBook — quota limit reached" },
  { pct: 80,  level: 80,  label: "near", subject: "AgencyBook — 80% of monthly quota used" },
];

async function ensureAlertTable() {
  await supabase.pool.query(`
    CREATE TABLE IF NOT EXISTS agency_quota_alerts (
      agency_id UUID NOT NULL,
      service   TEXT NOT NULL,
      period    TEXT NOT NULL,
      last_level INT NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (agency_id, service, period)
    )
  `);
}

async function listOwnersForAgency(agencyId) {
  const { rows } = await supabase.pool.query(
    `SELECT email, name FROM users WHERE agency_id = $1 AND role = 'owner' AND email IS NOT NULL`,
    [agencyId]
  );
  return rows;
}

function buildEmailHtml({ agencyName, service, used, quota, pct, tier }) {
  const serviceLabel = integrations.SERVICES[service]?.label || service;
  return `
    <p>Hi ${agencyName} team,</p>
    <p>Your <strong>${serviceLabel}</strong> usage on the <strong>${tier}</strong>
    plan has reached <strong>${used}/${quota} (${pct}%)</strong> for the
    current month.</p>
    ${pct >= 100
      ? `<p><strong>Action required:</strong> further requests will be blocked
         until the quota resets next month, or until you configure your own
         API key.</p>`
      : `<p>You'll start being throttled when usage hits the quota. To avoid
         interruption, you can upgrade your plan or — recommended for cost
         control at scale — provide your own API key under
         <strong>Settings → Integrations</strong>. Your own key has no
         platform quota and bills directly to your account.</p>`}
    <p style="margin-top: 20px; color: #888; font-size: 11px;">
      This alert is sent once per threshold per month per service. To stop
      receiving them, configure your own ${serviceLabel} key in Settings →
      Integrations.
    </p>
  `;
}

async function runScan() {
  if (integrations.INSTANCE_MODE !== "shared") {
    return { skipped: "not shared mode" };
  }

  await ensureAlertTable();
  const period = new Date().toISOString().slice(0, 7);
  const sent = [];
  const skipped = [];

  // Find every (agency, service) pair currently consuming platform key
  // with usage > 0 this month
  const { rows } = await supabase.pool.query(
    `SELECT u.agency_id, u.service, u.call_count, a.name AS agency_name, a.plan
     FROM agency_api_usage u
     JOIN agencies a ON a.id = u.agency_id
     WHERE u.period = $1 AND u.call_count > 0
       AND NOT EXISTS (
         SELECT 1 FROM agency_integrations i
         WHERE i.agency_id = u.agency_id AND i.service = u.service AND i.enabled = true
       )`,
    [period]
  );

  for (const r of rows) {
    const tier = r.plan || "starter";
    const quota = await integrations.getPlatformQuota(tier, r.service);
    if (quota <= 0) continue; // unlimited or zero — skip

    const pct = Math.round((r.call_count / quota) * 100);
    const threshold = ALERT_THRESHOLDS.find(a => pct >= a.pct);
    if (!threshold) continue;

    // Has this level already been alerted for this (agency, service, period)?
    const { rows: prior } = await supabase.pool.query(
      `SELECT last_level FROM agency_quota_alerts
       WHERE agency_id = $1 AND service = $2 AND period = $3`,
      [r.agency_id, r.service, period]
    );
    if (prior[0] && prior[0].last_level >= threshold.level) {
      skipped.push({ agency: r.agency_id, service: r.service, reason: "already alerted at level " + prior[0].last_level });
      continue;
    }

    // Send to all owner emails for this agency
    const owners = await listOwnersForAgency(r.agency_id);
    if (owners.length === 0) {
      skipped.push({ agency: r.agency_id, service: r.service, reason: "no owner email" });
      continue;
    }

    const html = buildEmailHtml({
      agencyName: r.agency_name,
      service: r.service,
      used: r.call_count,
      quota,
      pct,
      tier,
    });

    for (const o of owners) {
      const result = await sendEmail(null, {
        to: o.email,
        subject: threshold.subject,
        html,
      });
      sent.push({ agency: r.agency_id, service: r.service, to: o.email, level: threshold.level, ok: result.success });
    }

    // Mark this level as alerted so we don't re-send
    await supabase.pool.query(
      `INSERT INTO agency_quota_alerts (agency_id, service, period, last_level, last_sent_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (agency_id, service, period)
       DO UPDATE SET last_level = EXCLUDED.last_level, last_sent_at = now()`,
      [r.agency_id, r.service, period, threshold.level]
    );
  }

  console.log(`[quotaAlerts] sent=${sent.length} skipped=${skipped.length}`);
  return { sent: sent.length, skipped: skipped.length, period };
}

module.exports = { runScan };
