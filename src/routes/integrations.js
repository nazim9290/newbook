/**
 * routes/integrations.js — Per-agency BYOK credential management
 *
 * GET    /api/integrations              — list configured services + status
 * GET    /api/integrations/:service     — get masked credentials for one service
 * POST   /api/integrations/:service     — save credentials (encrypted at rest)
 * POST   /api/integrations/:service/test — verify credentials with a real API call
 * DELETE /api/integrations/:service     — remove credentials (revert to platform fallback)
 *
 * GET    /api/integrations/usage        — per-service monthly usage vs quota
 * GET    /api/integrations/_meta        — service catalog + tier requirements
 *
 * Auth/permission:
 *   - All endpoints require auth
 *   - Write endpoints require role 'owner' (per-agency top role) — even
 *     super_admin doesn't auto-pass; an owner manages their own agency
 *   - Read endpoints allow owner + super_admin (super_admin needs visibility
 *     across agencies via X-Switch-Agency header)
 *   - Tier gating: agency must be at SERVICES[service].tier_required or higher
 *     (skipped on enterprise instance — there's no tier hierarchy there)
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const logActivity = require("../lib/activityLog");
const integrations = require("../lib/integrations");

const router = express.Router();
router.use(auth);

// ── Helpers ─────────────────────────────────────────────────────────────
function isOwner(user) {
  const role = (user?.role || "").toLowerCase();
  return role === "owner";
}
function isSuperAdmin(user) {
  return (user?.role || "").toLowerCase() === "super_admin";
}

// Mask a credential value for display: keep first 4 + last 4 chars
function maskValue(v) {
  if (!v || typeof v !== "string") return "";
  if (v.length <= 12) return "****";
  return `${v.slice(0, 4)}...${v.slice(-4)}`;
}
function maskCredentials(service, creds) {
  if (!creds) return null;
  const def = integrations.SERVICES[service];
  const out = {};
  for (const k of def.fields) {
    if (creds[k] === undefined) continue;
    out[k] = def.secret_fields.includes(k) ? maskValue(creds[k]) : creds[k];
  }
  return out;
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/integrations/_meta — service catalog + agency's tier eligibility
// Returns SERVICES config so frontend can render Cards correctly.
router.get("/_meta", asyncHandler(async (req, res) => {
  const tier = await integrations.getAgencyTier(req.user.agency_id);
  const meta = {};
  for (const [service, def] of Object.entries(integrations.SERVICES)) {
    meta[service] = {
      label: def.label,
      fields: def.fields,
      secret_fields: def.secret_fields,
      tier_required: def.tier_required,
      tier_eligible: integrations.tierAllowsService(tier, service),
    };
  }
  res.json({
    instance_mode: integrations.INSTANCE_MODE,
    agency_tier: tier,
    services: meta,
  });
}));

// GET /api/integrations — list configured services for this agency
router.get("/", asyncHandler(async (req, res) => {
  const list = await integrations.listIntegrations(req.user.agency_id);
  res.json(list);
}));

// GET /api/integrations/usage — usage vs quota per service (current month)
router.get("/usage", asyncHandler(async (req, res) => {
  const tier = await integrations.getAgencyTier(req.user.agency_id);
  const out = {};
  for (const service of Object.keys(integrations.SERVICES)) {
    const quota = await integrations.getPlatformQuota(tier, service);
    const used = await integrations.getMonthlyUsage(req.user.agency_id, service);
    const byok = await integrations.loadAgencyCredential(req.user.agency_id, service);
    out[service] = {
      quota: quota === -1 ? "unlimited" : quota,
      used,
      using_own_key: !!byok,
    };
  }
  res.json({ tier, period: new Date().toISOString().slice(0, 7), services: out });
}));

// GET /api/integrations/:service — masked view of saved credentials
router.get("/:service", asyncHandler(async (req, res) => {
  const { service } = req.params;
  if (!integrations.SERVICES[service]) return res.status(404).json({ error: "Unknown service" });
  const creds = await integrations.loadAgencyCredential(req.user.agency_id, service);
  if (!creds) return res.json({ configured: false });
  res.json({
    configured: true,
    masked: maskCredentials(service, creds),
  });
}));

// POST /api/integrations/:service — save credentials (encrypts secret fields)
router.post("/:service", asyncHandler(async (req, res) => {
  const { service } = req.params;
  if (!integrations.SERVICES[service]) return res.status(404).json({ error: "Unknown service" });
  if (!isOwner(req.user)) return res.status(403).json({ error: "শুধু owner role এই credentials manage করতে পারে" });

  // Tier gate (skip on enterprise instance — single-tenant, no tiering)
  if (integrations.INSTANCE_MODE !== "enterprise") {
    const tier = await integrations.getAgencyTier(req.user.agency_id);
    if (!integrations.tierAllowsService(tier, service)) {
      return res.status(403).json({
        error: `${integrations.SERVICES[service].label} requires ${integrations.SERVICES[service].tier_required} tier or higher`,
        tier,
        required: integrations.SERVICES[service].tier_required,
      });
    }
  }

  const { credentials } = req.body;
  if (!credentials || typeof credentials !== "object") {
    return res.status(400).json({ error: "credentials object দিন" });
  }

  // Validate required fields are present
  const def = integrations.SERVICES[service];
  for (const f of def.fields) {
    // We don't strictly require every field — some are optional (e.g. SMTP `secure`).
    // But secret fields must be present on first save.
    if (def.secret_fields.includes(f) && !credentials[f]) {
      return res.status(400).json({ error: `Missing required field: ${f}` });
    }
  }

  const saved = await integrations.saveIntegration(
    req.user.agency_id,
    service,
    credentials,
    req.user.id
  );

  logActivity({
    agencyId: req.user.agency_id,
    userId: req.user.id,
    action: "update",
    module: "integrations",
    recordId: service,
    description: `${def.label} credentials configured`,
    ip: req.ip,
  }).catch(() => {});

  res.json(saved);
}));

// POST /api/integrations/:service/test — actually call upstream to verify
// Body can be:
//   { use_saved: true }       — test the currently saved credentials
//   { credentials: {...} }    — test a candidate set BEFORE saving (preferred UX)
router.post("/:service/test", asyncHandler(async (req, res) => {
  const { service } = req.params;
  if (!integrations.SERVICES[service]) return res.status(404).json({ error: "Unknown service" });
  if (!isOwner(req.user) && !isSuperAdmin(req.user)) {
    return res.status(403).json({ error: "শুধু owner role test করতে পারে" });
  }

  let credsToTest;
  if (req.body?.use_saved) {
    credsToTest = await integrations.loadAgencyCredential(req.user.agency_id, service);
    if (!credsToTest) return res.status(400).json({ error: "Saved credentials নেই — আগে save করুন" });
  } else if (req.body?.credentials) {
    credsToTest = req.body.credentials;
  } else {
    return res.status(400).json({ error: "credentials অথবা use_saved=true দিন" });
  }

  try {
    const result = await integrations.testCredential(service, credsToTest);
    if (req.body?.use_saved) {
      await integrations.recordValidation(req.user.agency_id, service, true);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    if (req.body?.use_saved) {
      await integrations.recordValidation(req.user.agency_id, service, false, err.message);
    }
    res.status(400).json({ ok: false, error: err.message });
  }
}));

// DELETE /api/integrations/:service — remove credentials
router.delete("/:service", asyncHandler(async (req, res) => {
  const { service } = req.params;
  if (!integrations.SERVICES[service]) return res.status(404).json({ error: "Unknown service" });
  if (!isOwner(req.user)) return res.status(403).json({ error: "শুধু owner role এই কাজ করতে পারে" });

  await integrations.deleteIntegration(req.user.agency_id, service);

  logActivity({
    agencyId: req.user.agency_id,
    userId: req.user.id,
    action: "delete",
    module: "integrations",
    recordId: service,
    description: `${integrations.SERVICES[service].label} integration removed`,
    ip: req.ip,
  }).catch(() => {});

  res.json({ success: true });
}));

module.exports = router;
