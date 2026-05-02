/**
 * eventBroadcaster.js — Cron-driven event detection + broadcast
 *
 * Polls activity_log + students + payments for recent events that owners
 * should know about, dispatches via dispatchToTopic (which fans out to
 * email/telegram/push). Idempotent via tracking columns.
 *
 * Jobs:
 *   1. autoNpsInvite()      — student status → ARRIVED → issue feedback token
 *   2. visaGrantedPush()    — student status → VISA_GRANTED → push to owner
 *   3. largePaymentPush()   — payment > threshold in last hour → push
 *   4. dailySummary()       — 08:00 daily KPI summary push + email to owners
 */

const crypto = require("crypto");
const supabase = require("./db");
const pool = supabase.pool;
const { dispatchToTopic } = require("./notify");

function genToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// ────────────────────────────────────────────────────────────
// Auto NPS feedback invitation — student arrived → issue token
// Runs every hour. Looks for students who reached ARRIVED in last 7 days
// and don't yet have a feedback_surveys row.
// ────────────────────────────────────────────────────────────
async function autoNpsInvite() {
  const { rows: agencies } = await pool.query(`
    SELECT a.id, a.name, s.enable_nps
    FROM agencies a
    LEFT JOIN agency_settings s ON s.agency_id = a.id
  `);

  let totalInvited = 0;
  for (const agency of agencies) {
    if (!agency.enable_nps) continue;

    // Find ARRIVED students without an existing 'arrived' feedback survey
    const { rows: candidates } = await pool.query(`
      SELECT s.id, s.name_en, s.name_bn, s.email, s.updated_at,
             sch.name_en AS school_name
      FROM students s
      LEFT JOIN schools sch ON sch.id = s.school_id
      LEFT JOIN feedback_surveys fs ON fs.student_id = s.id AND fs.trigger_event = 'arrived'
      WHERE s.agency_id = $1
        AND s.status = 'ARRIVED'
        AND s.updated_at > NOW() - INTERVAL '7 days'
        AND fs.id IS NULL
      LIMIT 50
    `, [agency.id]);

    for (const stu of candidates) {
      const token = genToken();
      const expires = new Date(); expires.setDate(expires.getDate() + 30);
      try {
        await pool.query(`
          INSERT INTO feedback_surveys (agency_id, student_id, trigger_event, language, link_token, link_expires_at)
          VALUES ($1, $2, 'arrived', 'bn', $3, $4)
        `, [agency.id, stu.id, token, expires.toISOString()]);

        // Email invite if available
        if (stu.email) {
          await dispatchToTopic({
            agencyId: agency.id,
            topic: "feedback_invite",
            template: "anomaly_alert",  // reuse template format
            data: {
              ruleType: "feedback_invite",
              actorName: stu.name_en || stu.name_bn,
              details: { token, link: `https://demo.agencybook.net/feedback/${token}`, school: stu.school_name },
              agencyName: agency.name,
            },
          });
        }
        totalInvited++;
      } catch (err) {
        console.error("[autoNpsInvite]", agency.id, stu.id, err.message);
      }
    }
  }
  return { invited: totalInvited };
}

// ────────────────────────────────────────────────────────────
// Visa Granted push — find students status changed to VISA_GRANTED in
// the last 30 min via activity_log, push owner.
// Tracking: activity_log row marked with metadata.notified=true via a
// scratch table (event_pushed_log)
// ────────────────────────────────────────────────────────────
async function ensurePushedLog() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_pushed_log (
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      pushed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (kind, record_id)
    )
  `);
}

async function visaGrantedPush() {
  await ensurePushedLog();

  // Find students currently in VISA_GRANTED whose update_at was recent
  // AND not yet pushed.
  const { rows } = await pool.query(`
    SELECT s.id, s.name_en, s.name_bn, s.agency_id, sch.name_en AS school_name
    FROM students s
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE s.status = 'VISA_GRANTED'
      AND s.updated_at > NOW() - INTERVAL '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM event_pushed_log
        WHERE kind = 'visa_granted' AND record_id = s.id
      )
  `);

  let pushed = 0;
  for (const stu of rows) {
    try {
      await dispatchToTopic({
        agencyId: stu.agency_id,
        topic: "all",
        template: "anomaly_alert",
        data: {
          ruleType: "🎉 Visa Granted",
          actorName: stu.name_en || stu.name_bn,
          details: { school: stu.school_name, message: "Student visa পেয়েছে — congratulate করুন!" },
          agencyName: "",
        },
      });
      await pool.query(
        `INSERT INTO event_pushed_log (kind, record_id) VALUES ('visa_granted', $1)
         ON CONFLICT DO NOTHING`,
        [stu.id]
      );
      pushed++;
    } catch (err) {
      console.error("[visaGrantedPush]", stu.id, err.message);
    }
  }
  return { pushed };
}

// ────────────────────────────────────────────────────────────
// Large Payment push — payments > threshold in last hour, not yet pushed
// ────────────────────────────────────────────────────────────
async function largePaymentPush() {
  await ensurePushedLog();
  const { rows: agencies } = await pool.query(`
    SELECT a.id, a.name, s.large_payment_threshold
    FROM agencies a
    LEFT JOIN agency_settings s ON s.agency_id = a.id
  `);

  let pushed = 0;
  for (const agency of agencies) {
    const threshold = Number(agency.large_payment_threshold || 100000);
    const { rows: payments } = await pool.query(`
      SELECT p.id, p.amount, p.method, p.date,
             s.name_en, s.name_bn
      FROM payments p
      LEFT JOIN students s ON s.id = p.student_id
      WHERE p.agency_id = $1
        AND p.amount >= $2
        AND p.created_at > NOW() - INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1 FROM event_pushed_log
          WHERE kind = 'large_payment' AND record_id = p.id::text
        )
    `, [agency.id, threshold]);

    for (const p of payments) {
      try {
        await dispatchToTopic({
          agencyId: agency.id,
          topic: "payment",
          template: "anomaly_alert",
          data: {
            ruleType: "💰 Large Payment Received",
            actorName: p.name_en || p.name_bn || "—",
            details: { amount: `৳${Number(p.amount).toLocaleString("en-IN")}`, method: p.method, date: p.date },
            agencyName: agency.name,
          },
        });
        await pool.query(
          `INSERT INTO event_pushed_log (kind, record_id) VALUES ('large_payment', $1)
           ON CONFLICT DO NOTHING`,
          [String(p.id)]
        );
        pushed++;
      } catch (err) {
        console.error("[largePaymentPush]", p.id, err.message);
      }
    }
  }
  return { pushed };
}

// ────────────────────────────────────────────────────────────
// Daily 8am summary — yesterday's KPIs to subscribed owners
// ────────────────────────────────────────────────────────────
async function dailySummary() {
  const { rows: agencies } = await pool.query(`SELECT id, name FROM agencies`);

  let summarized = 0;
  for (const agency of agencies) {
    try {
      const yesterdayStart = new Date(); yesterdayStart.setDate(yesterdayStart.getDate() - 1); yesterdayStart.setUTCHours(0, 0, 0, 0);
      const yesterdayEnd = new Date(); yesterdayEnd.setUTCHours(0, 0, 0, 0);

      const { rows: kpiRows } = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM visitors WHERE agency_id = $1 AND visit_date BETWEEN $2 AND $3) AS visitors,
          (SELECT COUNT(*)::int FROM students WHERE agency_id = $1 AND created_at BETWEEN $2 AND $3) AS new_students,
          (SELECT COALESCE(SUM(amount), 0)::numeric FROM payments WHERE agency_id = $1 AND date BETWEEN $2 AND $3) AS revenue,
          (SELECT COUNT(*)::int FROM students WHERE agency_id = $1 AND status = 'VISA_GRANTED' AND updated_at BETWEEN $2 AND $3) AS visas
      `, [agency.id, yesterdayStart.toISOString().slice(0, 10), yesterdayEnd.toISOString().slice(0, 10)]);

      const k = kpiRows[0];
      const summary = `Yesterday (${yesterdayStart.toISOString().slice(0, 10)}): ${k.visitors} visitor, ${k.new_students} নতুন student, ${k.visas} visa, ৳${Number(k.revenue).toLocaleString("en-IN")} collection`;

      await dispatchToTopic({
        agencyId: agency.id,
        topic: "daily_summary",
        template: "anomaly_alert",
        data: {
          ruleType: "📊 Daily Summary",
          actorName: agency.name,
          details: { yesterday: summary, ...k },
          agencyName: agency.name,
        },
      });
      summarized++;
    } catch (err) {
      console.error("[dailySummary]", agency.id, err.message);
    }
  }
  return { summarized };
}

module.exports = {
  autoNpsInvite,
  visaGrantedPush,
  largePaymentPush,
  dailySummary,
};
