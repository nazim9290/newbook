/**
 * forecast.js — Cash Flow Forecast (Phase 3 Feature 7)
 *
 * Mounted at /api/forecast
 *
 * Routes:
 *   GET  /cashflow?months=6      — projected revenue/expense/net by month
 *   GET  /probabilities          — current per-stage probabilities
 *   PATCH /probabilities/:status — owner override one stage
 *   POST /probabilities/refit    — auto-learn from past 12 months
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

// ────────────────────────────────────────────────────────────
// GET /cashflow — projected monthly revenue + expense
// ────────────────────────────────────────────────────────────
router.get("/cashflow", requireOwner, asyncHandler(async (req, res) => {
  const months = Math.min(12, Math.max(1, parseInt(req.query.months || "6", 10)));
  const agencyId = req.user.agency_id;

  // 1. Pull current pipeline + probabilities
  const { rows: probabilities } = await supabase.pool.query(
    `SELECT pipeline_status, probability, avg_days_to_complete
     FROM pipeline_stage_probabilities WHERE agency_id = $1`, [agencyId]
  );
  const probMap = {};
  for (const p of probabilities) {
    probMap[p.pipeline_status] = { probability: Number(p.probability), days: p.avg_days_to_complete };
  }

  // 2. Pull active pipeline students with their fee structures
  const { rows: students } = await supabase.pool.query(`
    SELECT s.id, s.status, s.school_id, sch.tuition_y1, sch.tuition_y2,
           sch.shoukai_fee, sch.admission_fee, sch.commission_rate,
           COALESCE((SELECT SUM(amount) FROM fee_items WHERE student_id = s.id), 0) AS fee_total,
           COALESCE((SELECT SUM(amount) FROM payments WHERE student_id = s.id), 0) AS paid
    FROM students s
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE s.agency_id = $1
      AND s.status NOT IN ('CANCELLED','PAUSED','COMPLETED','ARRIVED')
  `, [agencyId]);

  // 3. Bucket projected revenue by month
  const today = new Date();
  const buckets = [];
  for (let m = 0; m < months; m++) {
    const d = new Date(today.getFullYear(), today.getMonth() + m, 1);
    buckets.push({
      month: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString("en", { year: "numeric", month: "short" }),
      projected_revenue: 0,
      projected_expenses: 0,
      net: 0,
      contributing_students: 0,
    });
  }

  for (const stu of students) {
    const pInfo = probMap[stu.status];
    if (!pInfo) continue;

    // Outstanding receivables = fee_total - paid (or fall back to school tuition)
    const outstanding = Math.max(0,
      Number(stu.fee_total || stu.tuition_y1 || 0) - Number(stu.paid || 0)
    );
    if (outstanding <= 0) continue;

    // Expected = outstanding * probability of completing pipeline
    const expected = outstanding * pInfo.probability;

    // Bucket month = today + avg_days_to_complete
    const expectedDate = new Date(today.getTime() + pInfo.days * 24 * 60 * 60 * 1000);
    const expectedMonth = expectedDate.toISOString().slice(0, 7);
    const bucket = buckets.find(b => b.month === expectedMonth);
    if (bucket) {
      bucket.projected_revenue += expected;
      bucket.contributing_students += 1;
    }
  }

  // 4. Recurring expenses (HR salaries + recent average non-salary expenses)
  const { rows: salRows } = await supabase.pool.query(`
    SELECT COALESCE(SUM(monthly_salary), 0)::numeric AS total
    FROM employees WHERE agency_id = $1 AND status = 'active'
  `, [agencyId]).catch(() => ({ rows: [{ total: 0 }] }));
  const monthlySalaries = Number(salRows[0]?.total || 0);

  const { rows: avgExpRows } = await supabase.pool.query(`
    SELECT COALESCE(AVG(monthly), 0)::numeric AS monthly_avg FROM (
      SELECT TO_CHAR(date, 'YYYY-MM') AS m, SUM(amount) AS monthly
      FROM expenses
      WHERE agency_id = $1
        AND date > CURRENT_DATE - INTERVAL '6 months'
      GROUP BY 1
    ) t
  `, [agencyId]).catch(() => ({ rows: [{ monthly_avg: 0 }] }));
  const monthlyOpsAvg = Number(avgExpRows[0]?.monthly_avg || 0);

  for (const b of buckets) {
    b.projected_expenses = Math.round(monthlySalaries + monthlyOpsAvg);
    b.projected_revenue = Math.round(b.projected_revenue);
    b.net = Math.round(b.projected_revenue - b.projected_expenses);
  }

  res.json({
    months,
    monthly_salary_baseline: Math.round(monthlySalaries),
    monthly_ops_baseline: Math.round(monthlyOpsAvg),
    pipeline_total_students: students.length,
    buckets,
  });
}));

// ────────────────────────────────────────────────────────────
// GET /probabilities — list current settings
// ────────────────────────────────────────────────────────────
router.get("/probabilities", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT pipeline_status, probability, avg_days_to_complete, updated_at
     FROM pipeline_stage_probabilities
     WHERE agency_id = $1
     ORDER BY probability ASC`,
    [req.user.agency_id]
  );
  res.json(rows);
}));

// ────────────────────────────────────────────────────────────
// PATCH /probabilities/:status — owner override
// ────────────────────────────────────────────────────────────
router.patch("/probabilities/:status", requireOwner, asyncHandler(async (req, res) => {
  const { probability, avg_days_to_complete } = req.body || {};
  if (probability !== undefined && (probability < 0 || probability > 1)) {
    return res.status(400).json({ error: "probability 0–1 হতে হবে" });
  }
  const fields = [];
  const values = [];
  let idx = 1;
  if (probability !== undefined) { fields.push(`probability = $${idx++}`); values.push(probability); }
  if (avg_days_to_complete !== undefined) { fields.push(`avg_days_to_complete = $${idx++}`); values.push(avg_days_to_complete); }
  if (fields.length === 0) return res.status(400).json({ error: "কোনো field দেননি" });

  fields.push(`updated_at = NOW()`);
  values.push(req.user.agency_id, req.params.status);
  const { rows } = await supabase.pool.query(
    `UPDATE pipeline_stage_probabilities SET ${fields.join(", ")}
     WHERE agency_id = $${idx++} AND pipeline_status = $${idx++} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: "Stage পাওয়া যায়নি" });
  res.json(rows[0]);
}));

// ────────────────────────────────────────────────────────────
// POST /probabilities/refit — learn from last 12 months
// ────────────────────────────────────────────────────────────
router.post("/probabilities/refit", requireOwner, asyncHandler(async (req, res) => {
  // For each stage, count students who EVER had that status,
  // and how many of those eventually reached ARRIVED.
  // Naive approach: snapshot current students by stage; assume current ARRIVED rate as proxy.
  // (Real impl would parse activity_log status changes — out of scope for this iteration.)
  const { rows } = await supabase.pool.query(`
    SELECT status, COUNT(*)::int AS cnt,
           COUNT(*) FILTER (WHERE status IN ('ARRIVED','COMPLETED'))::int AS arrived_at_or_past
    FROM students
    WHERE agency_id = $1
    GROUP BY status
  `, [req.user.agency_id]);

  // Simple heuristic: if total = N and arrived = A, P(arrived | currently here) ~ A/N (very rough)
  // Better: use known progression. For now, we just nudge probabilities toward observed conversion.
  const totalArrived = rows.find(r => r.status === 'ARRIVED')?.cnt || 0;
  const totalEverEnrolled = rows.reduce((sum, r) => sum + r.cnt, 0);
  const overallRate = totalEverEnrolled > 0 ? totalArrived / totalEverEnrolled : 0.5;

  // Update probabilities scaled by overall rate (don't touch ARRIVED itself)
  const adjusted = [];
  const stages = ["VISITOR", "FOLLOW_UP", "ENROLLED", "IN_COURSE", "EXAM_PASSED",
                  "DOC_COLLECTION", "SCHOOL_INTERVIEW", "DOC_SUBMITTED", "COE_RECEIVED", "VISA_GRANTED"];
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    const rampUp = (i + 1) / stages.length;            // 0.1 ... 1.0 progression
    const newProb = Math.min(0.99, Math.max(0.02, rampUp * overallRate * 1.5));
    await supabase.pool.query(`
      UPDATE pipeline_stage_probabilities
      SET probability = $1, updated_at = NOW()
      WHERE agency_id = $2 AND pipeline_status = $3
    `, [newProb, req.user.agency_id, st]);
    adjusted.push({ stage: st, probability: Math.round(newProb * 1000) / 1000 });
  }

  res.json({
    overall_arrival_rate: Math.round(overallRate * 1000) / 1000,
    sample_size: totalEverEnrolled,
    adjusted,
  });
}));

module.exports = router;
