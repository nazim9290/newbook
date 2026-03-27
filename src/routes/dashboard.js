/**
 * dashboard.js — Dashboard API Route
 *
 * Dashboard-এর জন্য aggregated stats: student count, visitor count,
 * pipeline breakdown, revenue, recent visitors, upcoming tasks, alerts
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/supabase");

// ── GET /api/dashboard/stats — সব dashboard stats একসাথে ──
router.get("/stats", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const pool = supabase.pool;

  // সব query parallel-এ চলবে
  const [
    studentCountRes,
    visitorCountRes,
    pipelineRes,
    revenueRes,
    monthlyRevenueRes,
    expenseRes,
    recentVisitorsRes,
    upcomingTasksRes,
    duePaymentsRes,
    visaCountRes,
    docCountRes,
  ] = await Promise.all([
    // ১. মোট student + active count
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status NOT IN ('CANCELLED','PAUSED'))::int AS active
      FROM students WHERE agency_id = $1
    `, [agencyId]),

    // ২. মোট visitor count (এই মাসের + total)
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS this_month
      FROM visitors WHERE agency_id = $1
    `, [agencyId]),

    // ৩. Pipeline breakdown — status অনুযায়ী count
    pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM students WHERE agency_id = $1 AND status NOT IN ('CANCELLED','PAUSED')
      GROUP BY status ORDER BY count DESC
    `, [agencyId]),

    // ৪. এই মাসের মোট আয় (payments)
    pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM payments WHERE agency_id = $1
        AND date >= date_trunc('month', CURRENT_DATE)
    `, [agencyId]),

    // ৫. গত ৬ মাসের monthly revenue
    pool.query(`
      SELECT
        to_char(date_trunc('month', date), 'YYYY-MM') AS month,
        COALESCE(SUM(amount), 0)::numeric AS amount
      FROM payments WHERE agency_id = $1
        AND date >= (CURRENT_DATE - INTERVAL '6 months')
      GROUP BY date_trunc('month', date)
      ORDER BY month
    `, [agencyId]),

    // ৬. এই মাসের মোট ব্যয়
    pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM expenses WHERE agency_id = $1
        AND date >= date_trunc('month', CURRENT_DATE)
    `, [agencyId]),

    // ৭. সর্বশেষ ৫ visitor
    pool.query(`
      SELECT id, name, name_en, name_bn, phone, source, status,
        interested_countries, created_at
      FROM visitors WHERE agency_id = $1
      ORDER BY created_at DESC LIMIT 5
    `, [agencyId]),

    // ৮. আগামী ৭ দিনের task
    pool.query(`
      SELECT id, title, priority, status, due_date
      FROM tasks WHERE agency_id = $1 AND status != 'completed'
        AND due_date <= (CURRENT_DATE + INTERVAL '7 days')
      ORDER BY due_date ASC LIMIT 5
    `, [agencyId]),

    // ৯. বকেয়া payment (pending/partial)
    pool.query(`
      SELECT COALESCE(SUM(total_amount - paid_amount), 0)::numeric AS total_due
      FROM payments WHERE agency_id = $1 AND status IN ('pending', 'partial')
    `, [agencyId]),

    // ১০. ভিসা/পৌঁছেছে count
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM students WHERE agency_id = $1
        AND status IN ('VISA_GRANTED','ARRIVED','COMPLETED')
    `, [agencyId]),

    // ১১. ডক প্রসেসিং count
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM students WHERE agency_id = $1
        AND status IN ('DOC_COLLECTION','DOC_SUBMITTED','SCHOOL_INTERVIEW','DOC_IN_REVIEW')
    `, [agencyId]),
  ]);

  // বাংলা মাসের নাম
  const BN_MONTHS = ["জানু", "ফেব্রু", "মার্চ", "এপ্রি", "মে", "জুন", "জুলা", "আগ", "সেপ্টে", "অক্টো", "নভে", "ডিসে"];

  // Monthly revenue-তে বাংলা মাসের নাম যোগ
  const monthlyRevenue = monthlyRevenueRes.rows.map(r => {
    const [y, m] = r.month.split("-");
    return { month: BN_MONTHS[parseInt(m) - 1] + " " + y.slice(2), amount: Number(r.amount) };
  });

  // ── Alerts তৈরি ──
  const alerts = [];

  // বকেয়া alert
  const totalDue = Number(duePaymentsRes.rows[0].total_due);
  if (totalDue > 0) {
    alerts.push({ type: "warning", icon: "💰", text: `বকেয়া পেমেন্ট: ৳${totalDue.toLocaleString("en-IN")}`, time: "আজ" });
  }

  // Upcoming tasks alert
  const overdueTasks = upcomingTasksRes.rows.filter(t => new Date(t.due_date) < new Date());
  if (overdueTasks.length > 0) {
    alerts.push({ type: "critical", icon: "⚠️", text: `${overdueTasks.length}টি overdue task আছে`, time: "এখন" });
  }

  // ভিসা pending alert
  const visaApplied = pipelineRes.rows.find(r => r.status === "VISA_APPLIED");
  if (visaApplied && visaApplied.count > 0) {
    alerts.push({ type: "info", icon: "🛂", text: `${visaApplied.count}টি ভিসা আবেদন pending`, time: "চলমান" });
  }

  // COE received alert
  const coeReceived = pipelineRes.rows.find(r => r.status === "COE_RECEIVED");
  if (coeReceived && coeReceived.count > 0) {
    alerts.push({ type: "info", icon: "📄", text: `${coeReceived.count}টি COE পাওয়া গেছে — ভিসা আবেদন করুন`, time: "action needed" });
  }

  res.json({
    students: {
      total: studentCountRes.rows[0].total,
      active: studentCountRes.rows[0].active,
    },
    visitors: {
      total: visitorCountRes.rows[0].total,
      thisMonth: visitorCountRes.rows[0].this_month,
    },
    pipeline: pipelineRes.rows,
    revenue: {
      thisMonth: Number(revenueRes.rows[0].total),
      monthly: monthlyRevenue,
    },
    expenses: {
      thisMonth: Number(expenseRes.rows[0].total),
    },
    dues: totalDue,
    visaGranted: visaCountRes.rows[0].count,
    docInProgress: docCountRes.rows[0].count,
    recentVisitors: recentVisitorsRes.rows,
    upcomingTasks: upcomingTasksRes.rows,
    alerts,
  });
}));

module.exports = router;
