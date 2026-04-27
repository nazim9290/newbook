/**
 * reports.js — Reports & Analytics API Route
 *
 * Pipeline funnel, source analysis, dropout, country-wise stats —
 * সব real data থেকে compute করে দেয়
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/db");
const cache = require("../lib/cache");

// ── GET /api/reports/analytics — সব analytics data ──
router.get("/analytics", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;

  // ক্যাশ চেক — hit হলে DB query skip
  const cacheKey = `reports:${agencyId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const pool = supabase.pool;

  const [
    pipelineRes,
    sourceRes,
    countryRes,
    cancelledRes,
    totalStudentsRes,
    totalVisitorsRes,
    revenueRes,
    arrivedRes,
    expenseRes,
  ] = await Promise.all([
    // ১. Pipeline funnel — status অনুযায়ী count
    pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM students WHERE agency_id = $1
      GROUP BY status ORDER BY count DESC
    `, [agencyId]),

    // ২. Source analysis — source অনুযায়ী visitor → enrolled → arrived count
    pool.query(`
      SELECT
        COALESCE(source, 'Unknown') AS source,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status NOT IN ('VISITOR','FOLLOW_UP','CANCELLED','PAUSED'))::int AS enrolled,
        COUNT(*) FILTER (WHERE status IN ('ARRIVED','COMPLETED'))::int AS arrived
      FROM students WHERE agency_id = $1
      GROUP BY source ORDER BY total DESC
    `, [agencyId]),

    // ৩. Country-wise stats
    pool.query(`
      SELECT
        COALESCE(country, 'Japan') AS country,
        COUNT(*)::int AS students,
        COUNT(*) FILTER (WHERE status IN ('ARRIVED','COMPLETED'))::int AS arrived,
        COUNT(*) FILTER (WHERE status IN ('VISA_GRANTED','ARRIVED','COMPLETED'))::int AS visa_granted
      FROM students WHERE agency_id = $1
      GROUP BY country ORDER BY students DESC
    `, [agencyId]),

    // ৪. Cancelled/Paused (dropout) — কোন status থেকে কতজন ঝরে গেছে
    // সহজ approach: CANCELLED/PAUSED দের আগের status track করা কঠিন,
    // তাই funnel drop হিসাব করবো
    pool.query(`
      SELECT COUNT(*)::int AS cancelled
      FROM students WHERE agency_id = $1 AND status IN ('CANCELLED','PAUSED')
    `, [agencyId]),

    // ৫. Total student count
    pool.query(`SELECT COUNT(*)::int AS total FROM students WHERE agency_id = $1`, [agencyId]),

    // ৬. Total visitor count
    pool.query(`SELECT COUNT(*)::int AS total FROM visitors WHERE agency_id = $1`, [agencyId]),

    // ৭. Total revenue (all time)
    pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM payments WHERE agency_id = $1
    `, [agencyId]),

    // ৮. Total arrived
    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM students WHERE agency_id = $1 AND status IN ('ARRIVED','COMPLETED')
    `, [agencyId]),

    // ৯. Total expenses (all time)
    pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
      FROM expenses WHERE agency_id = $1
    `, [agencyId]),
  ]);

  // ── Pipeline funnel — Bengali label যোগ ──
  const STATUS_LABELS = {
    ENROLLED: "ভর্তি",
    IN_COURSE: "কোর্স চলছে", EXAM_PASSED: "পরীক্ষায় পাস",
    DOC_COLLECTION: "ডক কালেকশন", SCHOOL_INTERVIEW: "ইন্টারভিউ",
    DOC_SUBMITTED: "ডক জমা", DOC_IN_REVIEW: "ডক রিভিউতে",
    COE_RECEIVED: "COE পেয়েছে", HEALTH_CHECK: "হেলথ চেক",
    TUITION_REMITTED: "টিউশন পাঠানো", VFS_SCHEDULED: "VFS",
    VISA_APPLIED: "ভিসা আবেদন", VISA_GRANTED: "ভিসা পেয়েছে",
    PRE_DEPARTURE: "প্রি-ডিপার্চার", ARRIVED: "পৌঁছেছে",
    COMPLETED: "সম্পন্ন", CANCELLED: "বাতিল", PAUSED: "বিরতি",
  };

  const pipeline = pipelineRes.rows.map(r => ({
    status: r.status,
    stage: STATUS_LABELS[r.status] || r.status,
    count: r.count,
  }));

  // ── Source analysis — conversion % হিসাব ──
  const sourceAnalysis = sourceRes.rows.map(r => ({
    source: r.source,
    visitors: r.total,
    enrolled: r.enrolled,
    arrived: r.arrived,
    conversion: r.total > 0 ? Math.round((r.enrolled / r.total) * 100) : 0,
  }));

  // ── Country stats — revenue per country (approximate from total) ──
  const totalStudents = totalStudentsRes.rows[0].total;
  const totalRevenue = Number(revenueRes.rows[0].total);
  const countryStats = countryRes.rows.map(r => ({
    country: r.country,
    students: r.students,
    pct: totalStudents > 0 ? Math.round((r.students / totalStudents) * 100) : 0,
    arrived: r.arrived,
    visaGranted: r.visa_granted,
    // revenue approximate — total revenue * student proportion
    revenue: totalStudents > 0 ? Math.round((r.students / totalStudents) * totalRevenue) : 0,
  }));

  // ── Dropout — pipeline ordered ──
  const PIPELINE_ORDER = [
    "ENROLLED", "IN_COURSE", "EXAM_PASSED",
    "DOC_COLLECTION", "SCHOOL_INTERVIEW", "DOC_SUBMITTED",
    "COE_RECEIVED", "VISA_GRANTED", "ARRIVED", "COMPLETED",
  ];
  const pipelineMap = {};
  pipeline.forEach(p => { pipelineMap[p.status] = p.count; });

  // Dropout: each stage → how many less than previous stage
  const dropoutAnalysis = [];
  for (let i = 1; i < PIPELINE_ORDER.length; i++) {
    const prevCount = pipelineMap[PIPELINE_ORDER[i - 1]] || 0;
    const currCount = pipelineMap[PIPELINE_ORDER[i]] || 0;
    if (prevCount > 0) {
      const drop = prevCount - currCount;
      if (drop > 0) {
        dropoutAnalysis.push({
          stage: `${STATUS_LABELS[PIPELINE_ORDER[i - 1]]} → ${STATUS_LABELS[PIPELINE_ORDER[i]]}`,
          count: drop,
          pct: Math.round((drop / prevCount) * 100),
        });
      }
    }
  }
  // Cancelled/Paused যোগ
  const cancelledCount = cancelledRes.rows[0].cancelled;
  if (cancelledCount > 0) {
    dropoutAnalysis.push({
      stage: "বাতিল/বিরতি",
      count: cancelledCount,
      pct: totalStudents > 0 ? Math.round((cancelledCount / totalStudents) * 100) : 0,
    });
  }
  dropoutAnalysis.sort((a, b) => b.count - a.count);

  // ── KPI summary ──
  const arrived = arrivedRes.rows[0].total;
  const totalVis = totalVisitorsRes.rows[0].total + totalStudents; // visitors + students as total leads
  const overallConversion = totalVis > 0 ? Math.round((arrived / totalVis) * 100) : 0;
  const costPerStudent = arrived > 0 ? Math.round(Number(expenseRes.rows[0].total) / arrived) : 0;
  const dropoutRate = totalStudents > 0 ? Math.round((cancelledCount / totalStudents) * 100) : 0;

  // ক্যাশে সেট — ৫ মিনিট TTL
  const result = {
    kpi: {
      overallConversion,
      costPerStudent,
      totalArrived: arrived,
      dropoutRate,
      totalStudents,
      totalRevenue,
    },
    pipeline,
    sourceAnalysis,
    countryStats,
    dropoutAnalysis,
  };
  cache.set(cacheKey, result, 300); // ৫ মিনিট ক্যাশ
  res.json(result);
}));

module.exports = router;
