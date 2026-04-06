/**
 * analytics.js — Feature Usage Analytics Routes
 *
 * ফিচার ব্যবহার ট্র্যাকিং ও রিপোর্ট।
 * - POST /track — পেজ ভিউ বা অ্যাকশন log করে (debounce সহ)
 * - GET /summary — SuperAdmin: সামগ্রিক usage summary
 * - GET /agency/:id — SuperAdmin: নির্দিষ্ট agency-র usage
 */

const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();

// ═══════════════════════════════════════════════════════
// POST /api/analytics/track — পেজ ভিউ / অ্যাকশন log
// ═══════════════════════════════════════════════════════
// Auth optional — token থাকলে user info নেয়, না থাকলেও track করে
// একই user + page ৩০ সেকেন্ডের মধ্যে দ্বিতীয়বার track হবে না (debounce)
router.post("/track", optionalAuth, asyncHandler(async (req, res) => {
  const { page, action = "view", metadata } = req.body;

  // page ছাড়া track করা যাবে না
  if (!page) return res.status(400).json({ error: "page প্রয়োজন" });

  // user info — token থেকে পাওয়া গেলে ব্যবহার করো
  const userId = req.user?.id || null;
  const agencyId = req.user?.agency_id || null;
  const userName = req.user?.name || req.user?.email || null;
  const userRole = req.user?.role || null;

  // agency_id ছাড়া track করে লাভ নেই (anonymous visit skip)
  if (!agencyId) return res.json({ ok: true, skipped: true });

  // ── Debounce — একই user+page ৩০ সেকেন্ডের মধ্যে repeat হলে skip ──
  if (action === "view" && userId) {
    const pool = supabase.pool;
    const { rows } = await pool.query(
      `SELECT 1 FROM feature_usage
       WHERE user_id = $1 AND page = $2 AND action = 'view'
         AND created_at > now() - interval '30 seconds'
       LIMIT 1`,
      [userId, page]
    );
    if (rows.length > 0) return res.json({ ok: true, debounced: true });
  }

  // ── Insert — feature_usage table-এ log ──
  const { error } = await supabase.from("feature_usage").insert({
    agency_id: agencyId,
    user_id: userId,
    user_name: userName,
    user_role: userRole,
    page,
    action,
    metadata: metadata || null,
  });

  if (error) {
    console.error("[Analytics] Track error:", error.message);
    return res.status(500).json({ error: "ট্র্যাক ব্যর্থ" });
  }

  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════
// GET /api/analytics/summary — SuperAdmin: সামগ্রিক usage summary
// ═══════════════════════════════════════════════════════
// Query params: days (default 30), agency_id (optional filter)
router.get("/summary", auth, superOnly, asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const agencyFilter = req.query.agency_id || null;
  const pool = supabase.pool;

  // agency filter condition — নির্দিষ্ট agency হলে WHERE যোগ
  const agencyWhere = agencyFilter ? " AND agency_id = $2" : "";
  const params = agencyFilter ? [days, agencyFilter] : [days];

  // ── সব query parallel-এ চালাও (faster) ──
  const [
    pageViewsRes,
    actionsRes,
    activeUsersRes,
    peakHoursRes,
    dailyTrendRes,
    totalRes,
  ] = await Promise.all([
    // ১. পেজ অনুযায়ী view count
    pool.query(
      `SELECT page, COUNT(*)::int AS count
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}
       GROUP BY page ORDER BY count DESC`,
      params
    ),
    // ২. অ্যাকশন অনুযায়ী count
    pool.query(
      `SELECT action, COUNT(*)::int AS count
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}
       GROUP BY action ORDER BY count DESC`,
      params
    ),
    // ৩. সক্রিয় ব্যবহারকারী — সবচেয়ে বেশি active
    pool.query(
      `SELECT user_name, user_role, COUNT(*)::int AS count
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}
         AND user_name IS NOT NULL
       GROUP BY user_name, user_role ORDER BY count DESC
       LIMIT 50`,
      params
    ),
    // ৪. Peak hours — কোন ঘণ্টায় সবচেয়ে বেশি ব্যবহার
    pool.query(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}
       GROUP BY hour ORDER BY hour`,
      params
    ),
    // ৫. Daily trend — দিনভিত্তিক ব্যবহার
    pool.query(
      `SELECT created_at::date AS date, COUNT(*)::int AS count
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}
       GROUP BY date ORDER BY date`,
      params
    ),
    // ৬. মোট view count
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM feature_usage
       WHERE created_at > now() - ($1 || ' days')::interval${agencyWhere}`,
      params
    ),
  ]);

  res.json({
    pageViews: pageViewsRes.rows,
    actions: actionsRes.rows,
    activeUsers: activeUsersRes.rows,
    peakHours: peakHoursRes.rows,
    dailyTrend: dailyTrendRes.rows,
    totalViews: totalRes.rows[0]?.total || 0,
  });
}));

// ═══════════════════════════════════════════════════════
// GET /api/analytics/agency/:id — SuperAdmin: নির্দিষ্ট agency usage
// ═══════════════════════════════════════════════════════
router.get("/agency/:id", auth, superOnly, asyncHandler(async (req, res) => {
  const agencyId = req.params.id;
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const pool = supabase.pool;

  // ── Agency-র সব usage data parallel-এ আনো ──
  const [pageViewsRes, activeUsersRes, dailyTrendRes, totalRes, recentRes] = await Promise.all([
    // পেজ অনুযায়ী count
    pool.query(
      `SELECT page, COUNT(*)::int AS count
       FROM feature_usage
       WHERE agency_id = $1 AND created_at > now() - ($2 || ' days')::interval
       GROUP BY page ORDER BY count DESC`,
      [agencyId, days]
    ),
    // সক্রিয় ব্যবহারকারী
    pool.query(
      `SELECT user_name, user_role, COUNT(*)::int AS count
       FROM feature_usage
       WHERE agency_id = $1 AND created_at > now() - ($2 || ' days')::interval
         AND user_name IS NOT NULL
       GROUP BY user_name, user_role ORDER BY count DESC
       LIMIT 20`,
      [agencyId, days]
    ),
    // দৈনিক trend
    pool.query(
      `SELECT created_at::date AS date, COUNT(*)::int AS count
       FROM feature_usage
       WHERE agency_id = $1 AND created_at > now() - ($2 || ' days')::interval
       GROUP BY date ORDER BY date`,
      [agencyId, days]
    ),
    // মোট count
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM feature_usage
       WHERE agency_id = $1 AND created_at > now() - ($2 || ' days')::interval`,
      [agencyId, days]
    ),
    // সর্বশেষ ৫০টি activity
    pool.query(
      `SELECT page, action, user_name, user_role, metadata, created_at
       FROM feature_usage
       WHERE agency_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [agencyId]
    ),
  ]);

  res.json({
    agencyId,
    pageViews: pageViewsRes.rows,
    activeUsers: activeUsersRes.rows,
    dailyTrend: dailyTrendRes.rows,
    totalViews: totalRes.rows[0]?.total || 0,
    recentActivity: recentRes.rows,
  });
}));

// ═══════════════════════════════════════════════════════
// Helper Middleware
// ═══════════════════════════════════════════════════════

/**
 * optionalAuth — token থাকলে verify করে req.user-এ রাখে,
 * না থাকলেও next() কল করে (error দেয় না)।
 * /track endpoint-এ ব্যবহার — auth বাধ্যতামূলক না।
 */
function optionalAuth(req, res, next) {
  const jwt = require("jsonwebtoken");
  let token = null;

  // ১. Cookie থেকে token পড়ো
  if (req.cookies && req.cookies.agencybook_token) {
    token = req.cookies.agencybook_token;
  }

  // ২. Authorization header fallback
  if (!token) {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.slice(7);
    }
  }

  // Token না থাকলে skip — anonymous হিসেবে continue
  if (!token) return next();

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // Token invalid হলেও skip — track তো করতে পারে
  }
  next();
}

/**
 * superOnly — শুধু super_admin role access পাবে।
 * summary ও agency/:id endpoint-এ ব্যবহার হয়।
 */
function superOnly(req, res, next) {
  if (req.user?.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin access only" });
  }
  next();
}

module.exports = router;
