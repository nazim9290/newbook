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
    .select("*").eq("agency_id", agencyId).single();
  if (subErr) return res.status(500).json({ error: "Subscription লোড ব্যর্থ" });
  if (!sub) return res.status(404).json({ error: "এই agency-র জন্য subscription record নেই", code: "NO_SUBSCRIPTION" });

  // Linked plan details (legacy clients-এর plan_id NULL)
  let plan = null;
  if (sub.plan_id) {
    const { data: planRow } = await supabase.from("subscription_plans")
      .select("*").eq("id", sub.plan_id).single();
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
    .select("plan_id, legacy_pricing").eq("agency_id", agencyId).single();

  let plan = null;
  if (sub?.plan_id) {
    const { data } = await supabase.from("subscription_plans").select("*").eq("id", sub.plan_id).single();
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
    .select("plan_id, legacy_pricing, status").eq("agency_id", agencyId).single();

  // Legacy clients: কোনো limit enforce না
  if (sub?.legacy_pricing) return res.json({ ok: true, legacy: true, blocking: [] });

  // Status check
  if (["suspended", "cancelled"].includes(sub?.status || "")) {
    return res.json({ ok: false, status: sub.status, blocking: ["account_status"], message: "অ্যাকাউন্ট " + sub.status });
  }

  if (!sub?.plan_id) return res.json({ ok: true, legacy: false, blocking: [] });

  const { data: plan } = await supabase.from("subscription_plans").select("*").eq("id", sub.plan_id).single();
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

// ═══════════════════════════════════════════════════════════════════════
// MUTATE endpoints (Phase 2) — owner/super_admin only
// ═══════════════════════════════════════════════════════════════════════
const { invalidateCache } = require("../middleware/subscriptionGuard");

const isOwnerOrSuperAdmin = (user) => ["owner", "super_admin"].includes(user?.role);

// History helper
async function recordHistory(agencyId, eventType, fromCode, toCode, userId, notes, metadata) {
  await supabase.from("subscription_history").insert({
    agency_id: agencyId,
    event_type: eventType,
    from_plan_code: fromCode,
    to_plan_code: toCode,
    triggered_by: userId,
    notes,
    metadata: metadata || {},
  });
}

// ── POST /upgrade — change plan (also handles downgrade per Section 11.2) ──
// body: { plan_code, billing_cycle: "monthly"|"annual" }
router.post("/upgrade", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin plan change করতে পারে" });
  const { plan_code, billing_cycle = "monthly" } = req.body || {};
  if (!plan_code) return res.status(400).json({ error: "plan_code দিন" });
  if (!["monthly", "annual"].includes(billing_cycle)) return res.status(400).json({ error: "billing_cycle ভুল" });

  const agencyId = req.user.agency_id;

  // Target plan
  const { data: targetPlan } = await supabase.from("subscription_plans")
    .select("*").eq("code", plan_code).eq("is_active", true).single();
  if (!targetPlan) return res.status(404).json({ error: "এই plan available নেই" });

  // Current sub
  const { data: cur } = await supabase.from("agency_subscriptions")
    .select("*").eq("agency_id", agencyId).single();
  if (!cur) return res.status(404).json({ error: "Subscription record নেই" });

  // Determine event type — upgrade vs downgrade vs migration
  const fromOrder = cur.plan_id ? null : 0;     // legacy = 0
  let eventType = "upgraded";
  if (!cur.legacy_pricing && cur.plan_id) {
    const { data: oldPlan } = await supabase.from("subscription_plans").select("sort_order").eq("id", cur.plan_id).single();
    if (oldPlan && oldPlan.sort_order > targetPlan.sort_order) eventType = "downgraded";
  } else if (cur.legacy_pricing) {
    eventType = "upgraded";   // legacy → tier = treated as upgrade (legacy migration to new system)
  }

  // ── Section 11.2: Downgrade restriction — usage > new limit
  if (eventType === "downgraded") {
    const { count: usersCount } = await supabase.from("users").select("*", { count: "exact", head: true }).eq("agency_id", agencyId);
    const { count: branchesCount } = await supabase.from("branches").select("*", { count: "exact", head: true }).eq("agency_id", agencyId);
    if (targetPlan.max_users != null && usersCount > targetPlan.max_users) {
      return res.status(409).json({ error: `Downgrade ব্যর্থ: বর্তমান users (${usersCount}) > new tier limit (${targetPlan.max_users}) — আগে users কমান`, code: "DOWNGRADE_BLOCKED_USERS" });
    }
    if (targetPlan.max_branches != null && branchesCount > targetPlan.max_branches) {
      return res.status(409).json({ error: `Downgrade ব্যর্থ: বর্তমান branches (${branchesCount}) > new tier limit (${targetPlan.max_branches})`, code: "DOWNGRADE_BLOCKED_BRANCHES" });
    }
  }

  // Period calculation
  const now = new Date();
  const periodEnd = new Date(now);
  if (billing_cycle === "annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  else periodEnd.setMonth(periodEnd.getMonth() + 1);

  // Update subscription
  const updates = {
    plan_id: targetPlan.id,
    plan_code: targetPlan.code,
    billing_cycle,
    status: "active",
    current_period_start: now.toISOString(),
    current_period_end: periodEnd.toISOString(),
    cancel_at_period_end: false,
    cancelled_at: null,
    cancellation_reason: null,
    // Migrating from legacy = clear legacy fields
    legacy_pricing: false,
    legacy_per_student_rate: null,
    legacy_migration_deadline: null,
    updated_at: now.toISOString(),
  };
  const { error: upErr } = await supabase.from("agency_subscriptions").update(updates).eq("agency_id", agencyId);
  if (upErr) { console.error("[Upgrade]", upErr.message); return res.status(500).json({ error: "Update ব্যর্থ" }); }

  // Sync agencies.plan field for backwards compat
  await supabase.from("agencies").update({ plan: targetPlan.code }).eq("id", agencyId);

  // History
  await recordHistory(agencyId, eventType, cur.plan_code || (cur.legacy_pricing ? "legacy" : null), targetPlan.code, req.user.id,
    `Plan changed to ${targetPlan.code} (${billing_cycle})`,
    { billing_cycle, monthly_price: targetPlan.monthly_price, annual_price: targetPlan.annual_price });

  invalidateCache(agencyId);
  res.json({ success: true, plan: targetPlan, billing_cycle, current_period_end: periodEnd.toISOString(), event: eventType });
}));

// ── POST /cancel — schedule cancellation at period end (Section 11.3) ──
// body: { reason? }
router.post("/cancel", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin cancel করতে পারে" });
  const agencyId = req.user.agency_id;
  const { reason } = req.body || {};

  const { data: cur } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).single();
  if (!cur) return res.status(404).json({ error: "Subscription নেই" });
  if (cur.status === "cancelled") return res.status(400).json({ error: "ইতিমধ্যে cancel" });

  await supabase.from("agency_subscriptions").update({
    cancel_at_period_end: true,
    cancellation_reason: reason || null,
    cancelled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("agency_id", agencyId);

  await recordHistory(agencyId, "cancelled", cur.plan_code, cur.plan_code, req.user.id,
    `Cancellation scheduled (effective ${cur.current_period_end || "period end"})`,
    { reason });

  invalidateCache(agencyId);
  res.json({ success: true, effective_at: cur.current_period_end });
}));

// ── POST /reactivate — undo cancellation if still in current period ──
router.post("/reactivate", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin" });
  const agencyId = req.user.agency_id;

  const { data: cur } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).single();
  if (!cur) return res.status(404).json({ error: "Subscription নেই" });
  if (!cur.cancel_at_period_end) return res.status(400).json({ error: "Cancel scheduled নেই" });

  await supabase.from("agency_subscriptions").update({
    cancel_at_period_end: false,
    cancelled_at: null,
    cancellation_reason: null,
    status: "active",
    updated_at: new Date().toISOString(),
  }).eq("agency_id", agencyId);

  await recordHistory(agencyId, "reactivated", cur.plan_code, cur.plan_code, req.user.id, "Cancellation undone");
  invalidateCache(agencyId);
  res.json({ success: true });
}));

// ── POST /addons — add an add-on ──
// body: { addon_code, monthly_price?, quantity? }
router.post("/addons", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin" });
  const { addon_code, monthly_price, quantity = 1 } = req.body || {};
  if (!addon_code) return res.status(400).json({ error: "addon_code দিন" });

  // Price catalogue (Section 3) — server-side authoritative
  const ADDON_PRICES = {
    extra_branch: 1500,
    extra_users_5: 800,
    extra_storage_10gb: 500,
    premium_support: 3000,
    ai_translation: 2000,
    claude_vision_ocr: 1500,
  };
  const price = monthly_price || ADDON_PRICES[addon_code];
  if (price == null) return res.status(400).json({ error: "অজানা add-on" });

  const { data, error } = await supabase.from("subscription_addons").insert({
    agency_id: req.user.agency_id,
    addon_code, monthly_price: price, quantity,
    status: "active",
  }).select().single();
  if (error) { console.error("[Addon]", error.message); return res.status(500).json({ error: "Add-on add ব্যর্থ" }); }

  await recordHistory(req.user.agency_id, "addon_added", null, null, req.user.id, `Add-on: ${addon_code} (৳${price}/mo × ${quantity})`, { addon_code, price, quantity });
  invalidateCache(req.user.agency_id);
  res.json(data);
}));

// ── DELETE /addons/:id — cancel an add-on (effective end of period per Section 3) ──
router.delete("/addons/:id", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin" });

  // Get current period end for this agency to set ends_at
  const { data: sub } = await supabase.from("agency_subscriptions").select("current_period_end").eq("agency_id", req.user.agency_id).single();
  const endsAt = sub?.current_period_end || new Date().toISOString();

  const { data, error } = await supabase.from("subscription_addons")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), ends_at: endsAt, updated_at: new Date().toISOString() })
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error || !data) return res.status(404).json({ error: "Add-on পাওয়া যায়নি" });

  await recordHistory(req.user.agency_id, "addon_removed", null, null, req.user.id, `Add-on cancelled: ${data.addon_code}`, { addon_code: data.addon_code });
  invalidateCache(req.user.agency_id);
  res.json({ success: true, ends_at: endsAt });
}));

module.exports = router;
