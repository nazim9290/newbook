/**
 * auth-2fa-admin.js — Admin-only 2FA management
 *
 * Mounted at /api/auth/2fa/admin
 *
 * Routes:
 *   GET  /users          — list agency users with 2FA status
 *   POST /enable/:userId — set totp_required=true (force enrollment next login)
 *   POST /disable/:userId — clear required + secret + backup codes
 *   POST /reset/:userId   — wipe secret/codes, keep totp_required=true
 *   GET  /audit           — paginated 2FA event log (filtered to agency)
 *
 * Multi-tenant safety: every route verifies target.agency_id === req.user.agency_id.
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { log2FAEvent } = require("../lib/totp");

const router = express.Router();

// ── Admin-tier role guard ──
const ADMIN_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);

function requireAdmin(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return res.status(403).json({ error: "আপনার এই কাজের অনুমতি নেই" });
  }
  next();
}

router.use(auth, requireAdmin);

// Helper: load target user and verify same agency
async function loadTarget(req, res) {
  const { userId } = req.params;
  if (!userId) {
    res.status(400).json({ error: "User ID দিন" });
    return null;
  }
  const { data: target, error } = await supabase
    .from("users").select("*").eq("id", userId).single();
  if (error || !target) {
    res.status(404).json({ error: "User পাওয়া যায়নি" });
    return null;
  }
  if (target.agency_id !== req.user.agency_id) {
    res.status(403).json({ error: "ভিন্ন agency-র user — অনুমতি নেই" });
    return null;
  }
  return target;
}

// ════════════════════════════════════════════════════════════
// GET /users — list agency users with 2FA status
// ════════════════════════════════════════════════════════════
router.get("/users", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select("id, name, email, role, totp_enabled, totp_required, totp_enrolled_at, last_2fa_at")
    .eq("agency_id", req.user.agency_id)
    .order("name", { ascending: true });

  if (error) {
    console.error("[2FA admin/users]", error.message);
    return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  }
  res.json(data || []);
}));

// ════════════════════════════════════════════════════════════
// POST /enable/:userId — admin forces 2FA on user
// ════════════════════════════════════════════════════════════
router.post("/enable/:userId", asyncHandler(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;

  await supabase.from("users").update({ totp_required: true }).eq("id", target.id);

  log2FAEvent({
    supabase, agencyId: target.agency_id, userId: target.id, actorId: req.user.id,
    event: "admin_enabled", ip: req.ip, userAgent: req.headers["user-agent"],
    metadata: { target_email: target.email },
  });

  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
// POST /disable/:userId — admin removes the force-required flag only
// User's existing 2FA setup (secret, backup codes, enabled flag) stays
// intact — admin cannot destroy a user's own 2FA data.
// To wipe a user's setup (e.g. lost phone), use /reset.
// ════════════════════════════════════════════════════════════
router.post("/disable/:userId", asyncHandler(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;

  await supabase.from("users").update({
    totp_required: false,
  }).eq("id", target.id);

  log2FAEvent({
    supabase, agencyId: target.agency_id, userId: target.id, actorId: req.user.id,
    event: "admin_unrequired", ip: req.ip, userAgent: req.headers["user-agent"],
    metadata: { target_email: target.email },
  });

  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
// POST /reset/:userId — wipe setup, keep required flag (force re-enroll)
// ════════════════════════════════════════════════════════════
router.post("/reset/:userId", asyncHandler(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;

  await supabase.from("users").update({
    totp_enabled: false,
    totp_secret: null,
    totp_backup_codes: null,
    totp_enrolled_at: null,
    totp_required: true,
  }).eq("id", target.id);

  log2FAEvent({
    supabase, agencyId: target.agency_id, userId: target.id, actorId: req.user.id,
    event: "admin_reset", ip: req.ip, userAgent: req.headers["user-agent"],
    metadata: { target_email: target.email },
  });

  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
// GET /audit — paginated 2FA event log for this agency
// Query: user_id, event, from, to, page, limit
// ════════════════════════════════════════════════════════════
router.get("/audit", asyncHandler(async (req, res) => {
  const { user_id, event, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const offset = (page - 1) * limit;

  let q = supabase.from("auth_2fa_events").select("*").eq("agency_id", req.user.agency_id);
  if (user_id) q = q.eq("user_id", user_id);
  if (event) q = q.eq("event", event);
  if (from) q = q.gte("created_at", from);
  if (to) q = q.lte("created_at", to);
  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data: events, error } = await q;
  if (error) {
    console.error("[2FA audit]", error.message);
    return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  }

  // Hydrate user/actor names — collect IDs, batch fetch
  const ids = new Set();
  (events || []).forEach((e) => {
    if (e.user_id) ids.add(e.user_id);
    if (e.actor_id) ids.add(e.actor_id);
  });

  let userMap = {};
  if (ids.size > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, name, email")
      .in("id", Array.from(ids));
    (users || []).forEach((u) => { userMap[u.id] = u; });
  }

  const enriched = (events || []).map((e) => ({
    ...e,
    target: userMap[e.user_id] || null,
    actor: e.actor_id ? userMap[e.actor_id] || null : null,
  }));

  res.json({ events: enriched, page, limit });
}));

module.exports = router;
