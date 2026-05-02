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

  // ── OCR Credits balance + last topup ──
  let ocrCredits = { balance: 0, last_topup_at: null, last_topup_amount: 0 };
  try {
    const { rows: agRows } = await supabase.pool.query(
      "SELECT COALESCE(ocr_credits, 0) AS balance FROM agencies WHERE id = $1",
      [agencyId]
    );
    ocrCredits.balance = Number(agRows?.[0]?.balance || 0);
    const { rows: topRows } = await supabase.pool.query(
      "SELECT amount, created_at FROM ocr_credit_log WHERE agency_id = $1 AND type = 'topup' ORDER BY created_at DESC LIMIT 1",
      [agencyId]
    );
    if (topRows?.[0]) {
      ocrCredits.last_topup_amount = Number(topRows[0].amount || 0);
      ocrCredits.last_topup_at = topRows[0].created_at;
    }
  } catch { /* ignore */ }

  // ── Doc Generation counts (docgen + excel + docdata create events) ──
  // Source: activity_log create events from doc-generation modules
  let docGen = { this_month: 0, last_month: 0, avg_per_student: 0 };
  try {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const lastMonthStart = new Date(monthStart); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    const { rows } = await supabase.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $2) AS this_month,
        COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $2) AS last_month
      FROM activity_log
      WHERE agency_id = $1
        AND action = 'create'
        AND module IN ('docgen', 'excel', 'docdata')
    `, [agencyId, monthStart.toISOString(), lastMonthStart.toISOString()]);
    docGen.this_month = Number(rows?.[0]?.this_month || 0);
    docGen.last_month = Number(rows?.[0]?.last_month || 0);
    if (studentsUsed > 0) {
      docGen.avg_per_student = Math.round((docGen.this_month / studentsUsed) * 10) / 10;
    }
  } catch { /* ignore */ }

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
    ocr_credits: ocrCredits,
    doc_gen: docGen,
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

// ── Helper: pro-rate billing on mid-cycle upgrade (Section 4.7) ──
// Formula: prorated_charge = new_plan_full_price × (days_remaining / days_in_period)
//        - already_paid_unused_credit
// Returns: { full_charge, credit, net_charge, days_remaining, days_in_period }
function calculateProRatedCharge({ oldPlan, oldCycle, newPlan, newCycle, currentPeriodStart, currentPeriodEnd }) {
  const now = new Date();
  const start = new Date(currentPeriodStart);
  const end = new Date(currentPeriodEnd);
  const totalMs = end - start;
  const remainingMs = Math.max(0, end - now);
  const daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
  const daysInPeriod = Math.max(1, Math.ceil(totalMs / (1000 * 60 * 60 * 24)));

  // Unused credit from current plan
  const oldFullPrice = oldPlan ? Number(oldCycle === "annual" ? oldPlan.annual_price : oldPlan.monthly_price) : 0;
  const credit = Math.round(oldFullPrice * (daysRemaining / daysInPeriod));

  // Pro-rated charge for new plan over remaining period
  const newFullPrice = Number(newCycle === "annual" ? newPlan.annual_price : newPlan.monthly_price);
  const proratedNew = Math.round(newFullPrice * (daysRemaining / daysInPeriod));

  const netCharge = Math.max(0, proratedNew - credit);
  return {
    full_charge: newFullPrice,
    prorated_new: proratedNew,
    credit,
    net_charge: netCharge,
    days_remaining: daysRemaining,
    days_in_period: daysInPeriod,
  };
}

// ── GET /upgrade-preview — show pro-rated charge before user confirms ──
// query: ?plan_code=X&billing_cycle=monthly|annual
router.get("/upgrade-preview", asyncHandler(async (req, res) => {
  const { plan_code, billing_cycle = "monthly" } = req.query;
  if (!plan_code) return res.status(400).json({ error: "plan_code দিন" });
  const agencyId = req.user.agency_id;

  const { data: targetPlan } = await supabase.from("subscription_plans").select("*").eq("code", plan_code).maybeSingle();
  if (!targetPlan) return res.status(404).json({ error: "Plan নেই" });

  const { data: cur } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).maybeSingle();
  if (!cur) return res.status(404).json({ error: "Subscription নেই" });

  let oldPlan = null;
  if (cur.plan_id) {
    const { data: p } = await supabase.from("subscription_plans").select("*").eq("id", cur.plan_id).maybeSingle();
    oldPlan = p;
  }

  // Legacy → tier: full charge, no credit (per-student model isn't comparable)
  if (cur.legacy_pricing) {
    const fullCharge = Number(billing_cycle === "annual" ? targetPlan.annual_price : targetPlan.monthly_price);
    return res.json({
      legacy_migration: true,
      full_charge: fullCharge, prorated_new: fullCharge, credit: 0, net_charge: fullCharge,
      days_remaining: 0, days_in_period: billing_cycle === "annual" ? 365 : 30,
      target_plan: targetPlan,
    });
  }

  const calc = calculateProRatedCharge({
    oldPlan, oldCycle: cur.billing_cycle, newPlan: targetPlan, newCycle: billing_cycle,
    currentPeriodStart: cur.current_period_start, currentPeriodEnd: cur.current_period_end,
  });
  res.json({ legacy_migration: false, ...calc, target_plan: targetPlan });
}));

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

  // Welcome email — fire-and-forget for new paid subscriptions / legacy migrations
  if (eventType === "upgraded") {
    (async () => {
      try {
        const { sendEmail } = require("../lib/email");
        const { buildWelcomeEmail } = require("../lib/emailTemplates/lifecycleEmails");
        const { data: agency } = await supabase.from("agencies")
          .select("id, name, email, billing_email, subdomain").eq("id", agencyId).maybeSingle();
        const recipient = agency?.billing_email || agency?.email;
        if (recipient) {
          const payload = buildWelcomeEmail({ agency, plan: targetPlan, billingCycle: billing_cycle, periodEnd });
          await sendEmail(null, { to: recipient, ...payload });
        }
      } catch (e) { console.error("[WelcomeEmail]", e.message); }
    })();
  }

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

  // Reactivated email — fire and forget
  (async () => {
    try { const { fireLifecycleEmail } = require("../lib/billingCron"); await fireLifecycleEmail(agencyId, "reactivated"); }
    catch (e) { console.error("[ReactEmail]", e.message); }
  })();

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

// ═══════════════════════════════════════════════════════════════════════
// Legacy migration wizard (Section 5)
// ═══════════════════════════════════════════════════════════════════════

// GET /migration/status — show legacy client their migration position + incentives
router.get("/migration/status", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { data: sub } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).maybeSingle();
  if (!sub) return res.status(404).json({ error: "Subscription নেই" });
  if (!sub.legacy_pricing) {
    return res.json({ is_legacy: false, migrated_already: true });
  }

  const today = new Date();
  const deadline = sub.legacy_migration_deadline ? new Date(sub.legacy_migration_deadline) : null;
  const daysLeft = deadline ? Math.ceil((deadline - today) / (1000 * 60 * 60 * 24)) : null;

  // Section 5.5: tier-based migration incentive
  let incentive = null;
  if (daysLeft != null) {
    if (daysLeft > 90) {
      incentive = {
        period: "early",
        label_bn: "এখন migrate করলে — ১ মাস ফ্রি + পরের ৬ মাস ৮০% rate",
        label_en: "Migrate now — 1 month free + 80% rate for next 6 months",
        free_months: 1, discount_pct: 20, discount_months: 6,
      };
    } else if (daysLeft > 60) {
      incentive = {
        period: "voluntary",
        label_bn: "এখন migrate করলে — ১ মাস ফ্রি",
        label_en: "Migrate now — 1 month free",
        free_months: 1, discount_pct: 0, discount_months: 0,
      };
    } else if (daysLeft > 0) {
      incentive = {
        period: "mandatory",
        label_bn: `Standard pricing (deadline ${daysLeft} দিন বাকি)`,
        label_en: `Standard pricing (${daysLeft} days until deadline)`,
        free_months: 0, discount_pct: 0, discount_months: 0,
      };
    } else {
      incentive = {
        period: "expired",
        label_bn: "Migration deadline পার হয়েছে — auto migration হবে",
        label_en: "Migration deadline passed — auto-migration imminent",
        free_months: 0, discount_pct: 0, discount_months: 0,
      };
    }
  }

  // Suggest plan based on student count
  const { count: studentCount } = await supabase.from("students").select("*", { count: "exact", head: true }).eq("agency_id", agencyId);
  const { count: branchCount } = await supabase.from("branches").select("*", { count: "exact", head: true }).eq("agency_id", agencyId);

  const recommended = (studentCount > 400 || branchCount > 2)
    ? "business"
    : (studentCount > 100 || branchCount > 1)
    ? "professional"
    : "starter";

  res.json({
    is_legacy: true,
    legacy_per_student_rate: Number(sub.legacy_per_student_rate || 0),
    deadline: sub.legacy_migration_deadline,
    days_left: daysLeft,
    incentive,
    current_usage: { students: studentCount, branches: branchCount },
    recommended_plan: recommended,
  });
}));

// ═══════════════════════════════════════════════════════════════════════
// Annual plan perks (Section 2.2)
// ═══════════════════════════════════════════════════════════════════════

// POST /annual-perks/claim-onboarding — mark free onboarding session as scheduled
// body: { preferred_date, preferred_time, notes }
router.post("/annual-perks/claim-onboarding", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin" });
  const { preferred_date, preferred_time, notes } = req.body || {};
  const agencyId = req.user.agency_id;

  const { data: sub } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).maybeSingle();
  if (!sub) return res.status(404).json({ error: "Subscription নেই" });
  if (sub.billing_cycle !== "annual") return res.status(403).json({ error: "Onboarding session শুধু Annual plan-এ available" });
  if (sub.annual_onboarding_done) return res.status(400).json({ error: "Onboarding ইতিমধ্যে claim করা হয়েছে" });

  await supabase.from("agency_subscriptions").update({
    annual_onboarding_done: true,
    metadata: {
      ...(sub.metadata || {}),
      onboarding_request: {
        preferred_date, preferred_time, notes,
        requested_at: new Date().toISOString(),
        requested_by: req.user.id,
      },
    },
    updated_at: new Date().toISOString(),
  }).eq("agency_id", agencyId);

  await recordHistory(agencyId, "onboarding_claimed", null, null, req.user.id,
    `Onboarding session requested for ${preferred_date || "TBD"}`,
    { preferred_date, preferred_time, notes });

  // Notify ops team via email
  (async () => {
    try {
      const { sendEmail } = require("../lib/email");
      const { data: agency } = await supabase.from("agencies").select("name, email, phone").eq("id", agencyId).maybeSingle();
      await sendEmail(null, {
        to: process.env.OPS_EMAIL || "billing@agencybook.net",
        subject: `[Onboarding Request] ${agency?.name || ""} — ${preferred_date || "TBD"}`,
        html: `<p><strong>${agency?.name}</strong> requested onboarding session.</p>
<p>Preferred: ${preferred_date || "—"} ${preferred_time || ""}</p>
<p>Notes: ${notes || "—"}</p>
<p>Contact: ${agency?.email || "—"} · ${agency?.phone || "—"}</p>`,
      });
    } catch (e) { /* ignore */ }
  })();

  invalidateCache(agencyId);
  res.json({ success: true });
}));

// POST /annual-perks/claim-free-addon — pick the free first-year add-on
// body: { addon_code }
router.post("/annual-perks/claim-free-addon", asyncHandler(async (req, res) => {
  if (!isOwnerOrSuperAdmin(req.user)) return res.status(403).json({ error: "শুধুমাত্র owner/admin" });
  const { addon_code } = req.body || {};
  if (!addon_code) return res.status(400).json({ error: "addon_code দিন" });

  const ADDON_PRICES = {
    extra_branch: 1500, extra_users_5: 800, extra_storage_10gb: 500,
    premium_support: 3000, ai_translation: 2000, claude_vision_ocr: 1500,
  };
  const price = ADDON_PRICES[addon_code];
  if (!price) return res.status(400).json({ error: "অজানা add-on" });

  const agencyId = req.user.agency_id;
  const { data: sub } = await supabase.from("agency_subscriptions").select("*").eq("agency_id", agencyId).maybeSingle();
  if (!sub) return res.status(404).json({ error: "Subscription নেই" });
  if (sub.billing_cycle !== "annual") return res.status(403).json({ error: "Free add-on শুধু Annual plan-এ" });
  if (sub.annual_free_addon_code) return res.status(400).json({ error: `ইতিমধ্যে claim করা হয়েছে: ${sub.annual_free_addon_code}` });

  // Insert as a free perk (is_free_annual_perk = true means no billing)
  const yearLater = new Date(); yearLater.setFullYear(yearLater.getFullYear() + 1);
  const { data: addon, error } = await supabase.from("subscription_addons").insert({
    agency_id: agencyId, addon_code, monthly_price: price, quantity: 1,
    status: "active", is_free_annual_perk: true,
    ends_at: yearLater.toISOString(),
  }).select().single();
  if (error) return res.status(500).json({ error: "Add-on activate ব্যর্থ" });

  await supabase.from("agency_subscriptions").update({
    annual_free_addon_code: addon_code,
    updated_at: new Date().toISOString(),
  }).eq("agency_id", agencyId);

  await recordHistory(agencyId, "addon_added", null, null, req.user.id,
    `Free annual add-on claimed: ${addon_code} (worth ৳${price}/mo, expires ${yearLater.toISOString().slice(0,10)})`,
    { addon_code, free: true, expires_at: yearLater.toISOString() });

  invalidateCache(agencyId);
  res.json({ success: true, addon });
}));

module.exports = router;
