/**
 * owner-analytics.js — Owner-facing analytics endpoints (Phase 2/3)
 *
 * Mounted at /api/owner-analytics
 *
 * Read-only — no migrations needed for these (uses existing tables).
 *
 * Routes:
 *   GET /counselor-leaderboard?from=&to=&branch=  — F5
 *   GET /branch-pnl?from=&to=                     — F6
 *   GET /school-roi?from=&to=                     — F9
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

function dateRange(req) {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    from: req.query.from || defaultFrom.toISOString().slice(0, 10),
    to: req.query.to || today.toISOString().slice(0, 10),
  };
}

// ════════════════════════════════════════════════════════════
// F5 — Counselor Performance Leaderboard
// ════════════════════════════════════════════════════════════
router.get("/counselor-leaderboard", requireOwner, asyncHandler(async (req, res) => {
  const { from, to } = dateRange(req);
  const branch = req.query.branch || null;

  // Pull all counselors in agency
  const { rows: counselors } = await supabase.pool.query(`
    SELECT id, name, email, branch
    FROM users
    WHERE agency_id = $1 AND role IN ('counselor', 'follow-up_executive', 'admission_officer')
      ${branch ? "AND branch = $2" : ""}
  `, branch ? [req.user.agency_id, branch] : [req.user.agency_id]);

  // Aggregate per-counselor metrics
  const items = [];
  for (const c of counselors) {
    const counselorIdent = [c.name, c.email].filter(Boolean);

    // Visitors received (counselor field matches name OR email)
    const { rows: vRows } = await supabase.pool.query(`
      SELECT COUNT(*)::int AS visitors_received,
             COUNT(*) FILTER (WHERE converted_student_id IS NOT NULL)::int AS visitors_converted,
             AVG(EXTRACT(DAY FROM (last_follow_up - visit_date)))
               FILTER (WHERE last_follow_up IS NOT NULL AND visit_date IS NOT NULL)::float AS avg_followup_lag
      FROM visitors
      WHERE agency_id = $1
        AND visit_date BETWEEN $2 AND $3
        AND counselor = ANY($4)
    `, [req.user.agency_id, from, to, counselorIdent]);

    const visReceived = vRows[0]?.visitors_received || 0;
    const visConverted = vRows[0]?.visitors_converted || 0;

    // Tasks
    const { rows: tRows } = await supabase.pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'done')::int AS tasks_completed,
             COUNT(*) FILTER (WHERE status != 'done' AND due_date < CURRENT_DATE)::int AS tasks_overdue
      FROM tasks
      WHERE agency_id = $1
        AND assigned_to = $2
        AND created_at >= $3
        AND created_at <= $4 || ' 23:59:59'::interval
    `, [req.user.agency_id, c.id, from, to]).catch(() => ({ rows: [{ tasks_completed: 0, tasks_overdue: 0 }] }));

    // Revenue contributed (from payments where collected_by = counselor name/email)
    const { rows: rRows } = await supabase.pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS revenue
      FROM payments
      WHERE agency_id = $1
        AND date BETWEEN $2 AND $3
        AND (received_by = ANY($4) OR collected_by = ANY($4))
    `, [req.user.agency_id, from, to, counselorIdent]).catch(() => ({ rows: [{ revenue: 0 }] }));

    items.push({
      counselor_id: c.id,
      name: c.name || c.email,
      email: c.email,
      branch: c.branch,
      visitors_received: visReceived,
      visitors_converted: visConverted,
      conversion_pct: visReceived > 0 ? Math.round(visConverted / visReceived * 1000) / 10 : 0,
      avg_followup_lag_days: vRows[0]?.avg_followup_lag ? Math.round(vRows[0].avg_followup_lag) : null,
      tasks_completed: tRows[0]?.tasks_completed || 0,
      tasks_overdue: tRows[0]?.tasks_overdue || 0,
      revenue_contributed: Number(rRows[0]?.revenue || 0),
    });
  }

  items.sort((a, b) => b.visitors_converted - a.visitors_converted);

  res.json({ from, to, branch, count: items.length, items });
}));

// ════════════════════════════════════════════════════════════
// F6 — Branch P&L
// ════════════════════════════════════════════════════════════
router.get("/branch-pnl", requireOwner, asyncHandler(async (req, res) => {
  const { from, to } = dateRange(req);

  // Get all branches for agency
  const { rows: branches } = await supabase.pool.query(`
    SELECT name FROM branches WHERE agency_id = $1
    UNION
    SELECT DISTINCT branch FROM students WHERE agency_id = $1 AND branch IS NOT NULL
    UNION
    SELECT DISTINCT branch FROM employees WHERE agency_id = $1 AND branch IS NOT NULL
  `, [req.user.agency_id]).catch(() => ({ rows: [{ name: "Main" }] }));

  const items = [];
  for (const b of branches) {
    const branchName = b.name;
    if (!branchName) continue;

    // Income from payments (linked via student.branch)
    const { rows: incRows } = await supabase.pool.query(`
      SELECT COALESCE(SUM(p.amount), 0)::numeric AS income,
             COUNT(DISTINCT p.student_id)::int AS paying_students
      FROM payments p
      LEFT JOIN students s ON s.id = p.student_id
      WHERE p.agency_id = $1
        AND p.date BETWEEN $2 AND $3
        AND s.branch = $4
    `, [req.user.agency_id, from, to, branchName]);

    // Direct expenses from accounts/expenses table
    const { rows: expRows } = await supabase.pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS expenses
      FROM expenses
      WHERE agency_id = $1
        AND date BETWEEN $2 AND $3
        AND branch = $4
    `, [req.user.agency_id, from, to, branchName]).catch(() => ({ rows: [{ expenses: 0 }] }));

    // Salary cost (employees in this branch — proportional to date range)
    const { rows: salRows } = await supabase.pool.query(`
      SELECT COALESCE(SUM(monthly_salary), 0)::numeric AS monthly_salary
      FROM employees
      WHERE agency_id = $1 AND branch = $2 AND status = 'active'
    `, [req.user.agency_id, branchName]).catch(() => ({ rows: [{ monthly_salary: 0 }] }));

    // Months in window
    const fromD = new Date(from);
    const toD = new Date(to);
    const months = Math.max(1, (toD.getFullYear() - fromD.getFullYear()) * 12 + (toD.getMonth() - fromD.getMonth()) + 1);

    // Active student count
    const { rows: stuRows } = await supabase.pool.query(`
      SELECT COUNT(*)::int AS student_count
      FROM students
      WHERE agency_id = $1 AND branch = $2 AND status NOT IN ('CANCELLED','PAUSED')
    `, [req.user.agency_id, branchName]);

    const income = Number(incRows[0]?.income || 0);
    const directExp = Number(expRows[0]?.expenses || 0);
    const salaryExp = Number(salRows[0]?.monthly_salary || 0) * months;
    const totalExp = directExp + salaryExp;
    const profit = income - totalExp;

    items.push({
      branch: branchName,
      income, direct_expenses: directExp, salary_expenses: salaryExp, total_expenses: totalExp,
      profit, profit_margin_pct: income > 0 ? Math.round(profit / income * 1000) / 10 : 0,
      student_count: stuRows[0]?.student_count || 0,
      paying_students: incRows[0]?.paying_students || 0,
      months,
    });
  }

  items.sort((a, b) => b.profit - a.profit);

  res.json({ from, to, count: items.length, items });
}));

// ════════════════════════════════════════════════════════════
// F9 — School ROI Ranking
// ════════════════════════════════════════════════════════════
router.get("/school-roi", requireOwner, asyncHandler(async (req, res) => {
  const { from, to } = dateRange(req);

  const { rows: schools } = await supabase.pool.query(`
    SELECT id, name_en, name_jp, country, commission_rate
    FROM schools
    WHERE agency_id = $1
  `, [req.user.agency_id]);

  const items = [];
  for (const sch of schools) {
    // Student stats per school
    const { rows: stuRows } = await supabase.pool.query(`
      SELECT
        COUNT(*)::int AS applied,
        COUNT(*) FILTER (WHERE status IN ('COE_RECEIVED','VISA_GRANTED','ARRIVED','COMPLETED'))::int AS reached_coe,
        COUNT(*) FILTER (WHERE status IN ('VISA_GRANTED','ARRIVED','COMPLETED'))::int AS visa_granted,
        COUNT(*) FILTER (WHERE status IN ('ARRIVED','COMPLETED'))::int AS arrived
      FROM students
      WHERE agency_id = $1 AND school_id = $2
        AND created_at BETWEEN $3 AND $4 || ' 23:59:59'::interval
    `, [req.user.agency_id, sch.id, from, to]);

    // Commission earned (from payments where category = shokai_fee or commission)
    const { rows: comRows } = await supabase.pool.query(`
      SELECT COALESCE(SUM(p.amount), 0)::numeric AS commission_earned
      FROM payments p
      LEFT JOIN students s ON s.id = p.student_id
      WHERE p.agency_id = $1
        AND s.school_id = $2
        AND p.date BETWEEN $3 AND $4
        AND p.category IN ('shokai_fee', 'commission', 'school_commission')
    `, [req.user.agency_id, sch.id, from, to]).catch(() => ({ rows: [{ commission_earned: 0 }] }));

    const applied = stuRows[0]?.applied || 0;
    const reachedCoe = stuRows[0]?.reached_coe || 0;
    const arrived = stuRows[0]?.arrived || 0;
    const commissionTotal = Number(comRows[0]?.commission_earned || 0);

    items.push({
      school_id: sch.id,
      name: sch.name_en,
      name_jp: sch.name_jp,
      country: sch.country,
      commission_rate: sch.commission_rate,
      applied, reached_coe: reachedCoe, visa_granted: stuRows[0]?.visa_granted || 0, arrived,
      conversion_pct: applied > 0 ? Math.round(arrived / applied * 1000) / 10 : 0,
      commission_total: commissionTotal,
      avg_commission_per_arrival: arrived > 0 ? Math.round(commissionTotal / arrived) : 0,
    });
  }

  items.sort((a, b) => b.commission_total - a.commission_total);

  res.json({ from, to, count: items.length, items });
}));

module.exports = router;
