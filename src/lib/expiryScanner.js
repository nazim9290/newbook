/**
 * expiryScanner.js — Daily scan for upcoming document/deadline expiries
 *
 * Runs daily 07:00 Asia/Dhaka via scheduler.
 *
 * For each agency:
 *   1. Read agency_settings thresholds (passport, visa, coe, school deadline).
 *   2. Find students where any tracked date is within threshold.
 *   3. Skip if (student, field, expiry_date) already alerted (idempotent).
 *   4. Dispatch email to subscribed users (topic='doc_expiry').
 *   5. Insert row in expiry_alerts_sent.
 */

const supabase = require("./db");
const pool = supabase.pool;
const { dispatchToTopic } = require("./notify");

// Days between two dates (date-only, no time)
function daysBetween(later, earlier) {
  const dayMs = 24 * 60 * 60 * 1000;
  const a = new Date(later); a.setUTCHours(0, 0, 0, 0);
  const b = new Date(earlier); b.setUTCHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / dayMs);
}

// Per-agency check
async function scanAgency(agency) {
  const stats = { agency_id: agency.id, scanned: 0, alerted: 0, skipped: 0, errors: 0 };

  // Load thresholds
  const { rows: settingsRows } = await pool.query(
    `SELECT * FROM agency_settings WHERE agency_id = $1`, [agency.id]
  );
  if (!settingsRows.length) return stats;
  const s = settingsRows[0];
  if (!s.enable_doc_expiry_alerts) {
    return { ...stats, skipped_reason: "disabled" };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  // Furthest threshold among the 4 fields
  const maxThreshold = Math.max(
    s.doc_expiry_warn_days  || 180,
    s.visa_expiry_warn_days || 30,
    s.coe_expiry_warn_days  || 14,
    s.school_deadline_warn_days || 30,
  );

  const horizon = new Date(today.getTime() + maxThreshold * 24 * 60 * 60 * 1000);
  const horizonStr = horizon.toISOString().slice(0, 10);

  // Pull students with at least one expiry in horizon
  const { rows: students } = await pool.query(`
    SELECT s.id, s.name_en, s.name_bn, s.passport_expiry, s.visa_expiry,
           s.coe_received_date, s.coe_validity_days,
           sch.deadline_april, sch.deadline_october, sch.name_en AS school_name
    FROM students s
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE s.agency_id = $1
      AND s.status NOT IN ('CANCELLED', 'COMPLETED', 'PAUSED')
      AND (
        (s.passport_expiry IS NOT NULL AND s.passport_expiry <= $2 AND s.passport_expiry >= $3)
        OR (s.visa_expiry IS NOT NULL AND s.visa_expiry <= $2 AND s.visa_expiry >= $3)
        OR (s.coe_received_date IS NOT NULL)
      )
  `, [agency.id, horizonStr, todayStr]);

  stats.scanned = students.length;

  // Field configs
  const fields = [
    { key: "passport_expiry",  field: "passport", thresholdDays: s.doc_expiry_warn_days  || 180 },
    { key: "visa_expiry",      field: "visa",     thresholdDays: s.visa_expiry_warn_days || 30 },
    // COE is computed: coe_received_date + coe_validity_days = effective expiry
    { key: "_coe",             field: "coe",      thresholdDays: s.coe_expiry_warn_days  || 14 },
    // school deadlines: per-student via batch.intake (skip in MVP — handled separately)
  ];

  for (const stu of students) {
    for (const f of fields) {
      let expiryDate = null;

      if (f.key === "_coe") {
        if (!stu.coe_received_date || !stu.coe_validity_days) continue;
        const coeExp = new Date(stu.coe_received_date);
        coeExp.setUTCDate(coeExp.getUTCDate() + (stu.coe_validity_days || 90));
        expiryDate = coeExp.toISOString().slice(0, 10);
      } else {
        if (!stu[f.key]) continue;
        expiryDate = String(stu[f.key]).slice(0, 10);
      }

      const daysRemaining = daysBetween(expiryDate, todayStr);
      if (daysRemaining < 0 || daysRemaining > f.thresholdDays) continue;

      // Idempotency: already alerted for this (student, field, expiry_date)?
      const { rows: prior } = await pool.query(
        `SELECT id FROM expiry_alerts_sent
         WHERE student_id = $1 AND field = $2 AND expiry_date = $3
         LIMIT 1`,
        [stu.id, f.field, expiryDate]
      );
      if (prior.length) { stats.skipped++; continue; }

      try {
        const dispatch = await dispatchToTopic({
          agencyId: agency.id,
          topic: "doc_expiry",
          template: "doc_expiry",
          data: {
            studentName: stu.name_en || stu.name_bn || "Unknown",
            displayId: stu.id,
            field: f.field,
            expiryDate,
            daysRemaining,
          },
        });

        // Record in alerts_sent regardless of dispatch success
        // (so we don't repeatedly try a misconfigured channel)
        await pool.query(
          `INSERT INTO expiry_alerts_sent (agency_id, student_id, field, expiry_date, days_remaining)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (student_id, field, expiry_date) DO NOTHING`,
          [agency.id, stu.id, f.field, expiryDate, daysRemaining]
        );

        if (dispatch.sent > 0) stats.alerted++;
        else stats.skipped++;  // no subscribers
      } catch (err) {
        console.error(`[expiryScanner] ${agency.id}/${stu.id}/${f.field}:`, err.message);
        stats.errors++;
      }
    }
  }

  return stats;
}

// Master scan — loop all agencies
async function runScan() {
  const { rows: agencies } = await pool.query(`SELECT id, name FROM agencies`);
  const results = [];
  for (const a of agencies) {
    try {
      const r = await scanAgency(a);
      results.push(r);
    } catch (err) {
      results.push({ agency_id: a.id, error: err.message });
    }
  }
  return {
    agencies_scanned: results.length,
    alerts_sent: results.reduce((a, b) => a + (b.alerted || 0), 0),
    students_scanned: results.reduce((a, b) => a + (b.scanned || 0), 0),
    per_agency: results,
  };
}

/**
 * Read upcoming expiries for an agency (used by Dashboard widget).
 * Doesn't dispatch alerts — just returns the data.
 */
async function listUpcoming(agencyId, withinDays = 90) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const horizon = new Date(today.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT s.id, s.name_en, s.name_bn, s.status, s.branch,
           s.passport_expiry, s.visa_expiry,
           s.coe_received_date, s.coe_validity_days,
           sch.name_en AS school_name
    FROM students s
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE s.agency_id = $1
      AND s.status NOT IN ('CANCELLED', 'COMPLETED', 'PAUSED')
      AND (
        (s.passport_expiry IS NOT NULL AND s.passport_expiry <= $2 AND s.passport_expiry >= $3)
        OR (s.visa_expiry IS NOT NULL AND s.visa_expiry <= $2 AND s.visa_expiry >= $3)
        OR (s.coe_received_date IS NOT NULL)
      )
    ORDER BY LEAST(
      COALESCE(s.passport_expiry, 'infinity'::date),
      COALESCE(s.visa_expiry, 'infinity'::date)
    ) ASC
    LIMIT 100
  `, [agencyId, horizonStr, todayStr]);

  // Materialize per-field rows
  const out = [];
  for (const r of rows) {
    if (r.passport_expiry) {
      const d = daysBetween(String(r.passport_expiry).slice(0, 10), todayStr);
      if (d >= 0 && d <= withinDays) out.push({
        student_id: r.id, student_name: r.name_en || r.name_bn,
        field: "passport", expiry_date: String(r.passport_expiry).slice(0, 10),
        days_remaining: d, branch: r.branch,
      });
    }
    if (r.visa_expiry) {
      const d = daysBetween(String(r.visa_expiry).slice(0, 10), todayStr);
      if (d >= 0 && d <= withinDays) out.push({
        student_id: r.id, student_name: r.name_en || r.name_bn,
        field: "visa", expiry_date: String(r.visa_expiry).slice(0, 10),
        days_remaining: d, branch: r.branch,
      });
    }
    if (r.coe_received_date && r.coe_validity_days) {
      const coeExp = new Date(r.coe_received_date);
      coeExp.setUTCDate(coeExp.getUTCDate() + r.coe_validity_days);
      const exp = coeExp.toISOString().slice(0, 10);
      const d = daysBetween(exp, todayStr);
      if (d >= 0 && d <= withinDays) out.push({
        student_id: r.id, student_name: r.name_en || r.name_bn,
        field: "coe", expiry_date: exp, days_remaining: d, branch: r.branch,
      });
    }
  }
  out.sort((a, b) => a.days_remaining - b.days_remaining);
  return out;
}

module.exports = {
  runScan,
  scanAgency,
  listUpcoming,
};
