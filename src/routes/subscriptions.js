/**
 * subscriptions.js — Subscription Management API (Phase 1: read-only)
 *
 * Master Plan v1.0 Section 7.1। Phase 1-এ শুধু read endpoints —
 * upgrade/cancel/addon mutate endpoints Phase 2-এ আসবে।
 *
 *   GET  /api/subscriptions/plans            — সব available plans (4 tiers)
 *   GET  /api/subscriptions/current          — agency-র current subscription + plan + add-ons
 *   GET  /api/subscriptions/usage            — current usage vs limits (users/branches/students/storage)
 *   GET  /api/subscriptions/check-limits     — quick boolean: any limit exceeded?
 *   GET  /api/subscriptions/history          — plan change audit trail
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();

router.use(auth);

// ── Helper: count rows from a table for an agency ──
async function countFor(table, agencyId, extraFilter) {
  let q = supabase.from(table).select("*", { count: "exact", head: true }).eq("agency_id", agencyId);
  if (extraFilter) q = extraFilter(q);
  const { count } = await q;
  return count || 0;
}

// ── GET /plans — সব active plans, sort_order অনুযায়ী ──
router.get("/plans", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("subscription_plans")
    .select("*").eq("is_active", true).order("sort_order", { ascending: true });
  if (error) return res.status(500).json({ error: "প্ল্যান লোড ব্যর্থ" });
  res.json(data || []);
}));

// ── GET /current — current subscription + linked plan + active add-ons ──
router.get("/current", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;

  // Subscription record (one per agency — UNIQUE constraint)
  const { data: sub, error: subErr } = await supabase.from("agency_subscriptions")
    .select("*").eq("agency_id", agencyId).maybeSingle();
  if (subErr) return res.status(500).json({ error: "Subscription লোড ব্যর্থ" });
  if (!sub) return res.status(404).json({ error: "এই agency-র জন্য subscription record নেই", code: "NO_SUBSCRIPTION" });

  // Linked plan details (legacy clients-এর plan_id NULL)
  let plan = null;
  if (sub.plan_id) {
    const { data: planRow } = await supabase.from("subscription_plans")
      .select("*").eq("id", sub.plan_id).maybeSingle();
    plan = planRow || null;
  }

  // Active add-ons
  const { data: addons } = await supabase.from("subscription_addons")
    .select("*").eq("agency_id", agencyId).eq("status", "active");

  // ── Trial days remaining (যদি trial status হয়) ──
  let trialDaysRemaining = null;
  if (sub.status === "trial" && sub.trial_ends_at) {
    const ms = new Date(sub.trial_ends_at).getTime() - Date.now();
    trialDaysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }

  // ── Days overdue (past_due / suspended-এর জন্য) ──
  let daysOverdue = null;
  if (["past_due", "suspended"].includes(sub.status) && sub.current_period_end) {
    const ms = Date.now() - new Date(sub.current_period_end).getTime();
    daysOverdue = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  }

  res.json({
    subscription: sub,
    plan,
    addons: addons || [],
    trial_days_remaining: trialDaysRemaining,
    days_overdue: daysOverdue,
    is_legacy: !!sub.legacy_pricing,
  });
}));

// ── GET /usage — current usage vs limits ──
// Returns: { users: { used, limit, pct }, branches: {...}, students: {...}, storage: {...} }
router.get("/usage", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;

  const { data: sub } = await supabase.from("agency_subscriptions")
    .select("plan_id, legacy_pricing").eq("agency_id", agencyId).maybeSingle();

  let plan = null;
  if (sub?.plan_id) {
    const { data } = await supabase.from("subscription_plans").select("*").eq("id", sub.plan_id).maybeSingle();
    plan = data;
  }

  // Count current usage
  const [usersUsed, branchesUsed, studentsUsed] = await Promise.all([
    countFor("users", agencyId),
    countFor("branches", agencyId),
    countFor("students", agencyId),
  ]);

  // Storage — file_size column থেকে SUM (যদি থাকে); নাহলে 0
  // Phase 1-এ approximation; Phase 3-এ proper file storage tracking
  let storageMb = 0;
  try {
    const { rows } = await supabase.pool.query(
      "SELECT COALESCE(SUM(file_size),0) AS bytes FROM documents WHERE agency_id = $1",
      [agencyId]
    );
    storageMb = Number(rows?.[0]?.bytes || 0) / (1024 * 1024);
  } catch { /* table or column missing — ignore */ }

  // Build usage object
  const fmt = (used, limit) => ({
    used,
    limit: limit ?? null,             // null = unlimited
    pct: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    exceeded: limit ? used > limit : false,
    is_unlimited: limit == null,
  });

  res.json({
    legacy: !!sub?.legacy_pricing,
    plan_code: plan?.code || (sub?.legacy_pricing ? "legacy" : null),
    users:    fmt(usersUsed,    plan?.max_users),
    branches: fmt(branchesUsed, plan?.max_branches),
    students: { ...fmt(studentsUsed, plan?.soft_max_students), is_soft_cap: true },
    storage:  fmt(Math.round(storageMb * 100) / 100, plan ? plan.max_storage_gb * 1024 : null),  // both in MB
    storage_unit: "MB",
  });
}));

// ── GET /check-limits — quick boolean ──
router.get("/check-limits", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { data: sub } = await supabase.from("agency_subscriptions")
    .select("plan_id, legacy_pricing, status").eq("agency_id", agencyId).maybeSingle();

  // Legacy clients: কোনো limit enforce না
  if (sub?.legacy_pricing) return res.json({ ok: true, legacy: true, blocking: [] });

  // Status check
  if (["suspended", "cancelled"].includes(sub?.status || "")) {
    return res.json({ ok: false, status: sub.status, blocking: ["account_status"], message: "অ্যাকাউন্ট " + sub.status });
  }

  if (!sub?.plan_id) return res.json({ ok: true, legacy: false, blocking: [] });

  const { data: plan } = await supabase.from("subscription_plans").select("*").eq("id", sub.plan_id).maybeSingle();
  if (!plan) return res.json({ ok: true, blocking: [] });

  const [usersUsed, branchesUsed] = await Promise.all([
    countFor("users", agencyId),
    countFor("branches", agencyId),
  ]);

  const blocking = [];
  if (plan.max_users != null && usersUsed > plan.max_users) blocking.push("users");
  if (plan.max_branches != null && branchesUsed > plan.max_branches) blocking.push("branches");

  res.json({ ok: blocking.length === 0, legacy: false, status: sub.status, blocking });
}));

// ── GET /history — plan change audit trail ──
router.get("/history", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("subscription_history")
    .select("*").eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: "History লোড ব্যর্থ" });
  res.json(data || []);
}));

module.exports = router;
