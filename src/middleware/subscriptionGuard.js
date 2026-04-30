/**
 * subscriptionGuard.js — Tier limit + status enforcement (Master Plan v1.0 Phase 2)
 *
 * Two middlewares:
 *
 *   requireActiveStatus()
 *     — suspended/cancelled accounts শুধু READ allowed; write blocked 403
 *     — past_due-তে warning header attach but পাস
 *     — legacy clients সব bypass (Section 5.4)
 *     — Mount globally on write routes (POST/PATCH/PUT/DELETE)
 *
 *   enforceLimit(resource)
 *     — resource = 'users' | 'branches'
 *     — limit hit হলে 403 with upgrade CTA
 *     — legacy clients সব bypass
 *     — Mount on resource-specific create endpoints
 */

const supabase = require("../lib/db");

// In-memory cache — subscription/plan lookups প্রতি request-এ DB hit এড়াতে
// Auto-expire 60s (status change-এ stale window)
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function loadSubscription(agencyId) {
  const cached = cache.get(agencyId);
  if (cached && (Date.now() - cached.t) < CACHE_TTL_MS) return cached.data;

  const { data: sub } = await supabase.from("agency_subscriptions")
    .select("status, plan_id, legacy_pricing, trial_ends_at, current_period_end")
    .eq("agency_id", agencyId).single();
  if (!sub) {
    const empty = { sub: null, plan: null };
    cache.set(agencyId, { t: Date.now(), data: empty });
    return empty;
  }
  let plan = null;
  if (sub.plan_id) {
    const { data: p } = await supabase.from("subscription_plans")
      .select("max_users, max_branches, max_storage_gb, soft_max_students, code")
      .eq("id", sub.plan_id).single();
    plan = p;
  }
  const data = { sub, plan };
  cache.set(agencyId, { t: Date.now(), data });
  return data;
}

// Cache invalidate — change-plan / status update-এ call করো
function invalidate(agencyId) {
  if (agencyId) cache.delete(agencyId);
  else cache.clear();
}

// ── Middleware: require active status (write operations-এ) ──
function requireActiveStatus() {
  return async (req, res, next) => {
    if (!req.user?.agency_id) return next();   // unauthenticated/auth path — let it pass
    const { sub } = await loadSubscription(req.user.agency_id);
    if (!sub) return next();                    // no subscription record yet — don't block (super-admin/onboarding)

    // Legacy bypass — Section 5.4
    if (sub.legacy_pricing) return next();

    if (sub.status === "suspended") {
      return res.status(403).json({
        error: "অ্যাকাউন্ট suspended — read-only mode। বকেয়া invoice পরিশোধ করুন।",
        code: "SUBSCRIPTION_SUSPENDED",
        action: "pay_invoice",
      });
    }
    if (sub.status === "cancelled") {
      return res.status(403).json({
        error: "অ্যাকাউন্ট cancelled — পুনরায় চালু করতে super-admin-এর সাথে যোগাযোগ করুন।",
        code: "SUBSCRIPTION_CANCELLED",
      });
    }
    // past_due / trial / active — allow but inform via header
    if (sub.status === "past_due") res.setHeader("X-Subscription-Warning", "past_due");
    if (sub.status === "trial" && sub.trial_ends_at) {
      const days = Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86400000));
      if (days <= 3) res.setHeader("X-Subscription-Warning", `trial_ending_${days}d`);
    }
    next();
  };
}

// ── Middleware factory: enforce a hard cap on resource creation ──
function enforceLimit(resource) {
  return async (req, res, next) => {
    if (!req.user?.agency_id) return next();
    const { sub, plan } = await loadSubscription(req.user.agency_id);
    if (!sub || sub.legacy_pricing || !plan) return next();

    const limitField = ({ users: "max_users", branches: "max_branches" })[resource];
    if (!limitField) return next();
    const limit = plan[limitField];
    if (limit == null) return next();   // unlimited (enterprise)

    // Count current rows
    const tableMap = { users: "users", branches: "branches" };
    const { count } = await supabase.from(tableMap[resource])
      .select("*", { count: "exact", head: true })
      .eq("agency_id", req.user.agency_id);

    if ((count || 0) >= limit) {
      return res.status(403).json({
        error: `${resource} limit (${limit}) পৌঁছে গেছে — নতুন ${resource} যোগ করতে plan upgrade করুন বা add-on নিন।`,
        code: "TIER_LIMIT_EXCEEDED",
        resource,
        limit,
        current_used: count,
        plan_code: plan.code,
      });
    }
    next();
  };
}

module.exports = { requireActiveStatus, enforceLimit, invalidateCache: invalidate };
