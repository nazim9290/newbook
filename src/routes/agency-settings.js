/**
 * agency-settings.js — Owner-tunable per-agency settings
 *
 * Mounted at /api/agency-settings
 *
 * Routes:
 *   GET  /              — read settings for req.user.agency_id
 *   PATCH /             — update non-secret fields (thresholds, flags)
 *   PATCH /credentials  — update encrypted secret fields (api keys, tokens)
 *   POST /test-channel  — verify provider creds work (sends a test alert)
 *
 * Auth: owner / super_admin / admin role only.
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { encrypt, decrypt } = require("../lib/crypto");
const { notify } = require("../lib/notify");

const router = express.Router();

const OWNER_ROLES = new Set(["super_admin", "owner", "admin"]);

function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) {
    return res.status(403).json({ error: "শুধু owner/admin এই settings change করতে পারে" });
  }
  next();
}

router.use(auth, requireOwner);

// ── Whitelist columns user can PATCH ──
// Secret/credential columns are handled in /credentials separately.
const PUBLIC_PATCH_COLS = new Set([
  "doc_expiry_warn_days", "visa_expiry_warn_days", "coe_expiry_warn_days", "school_deadline_warn_days",
  "anomaly_after_hours_start", "anomaly_after_hours_end",
  "anomaly_bulk_delete_threshold", "anomaly_failed_login_threshold", "anomaly_failed_login_window_min",
  "large_payment_threshold", "large_refund_threshold", "fee_waiver_threshold",
  "enable_doc_expiry_alerts", "enable_anomaly_alerts", "enable_offsite_backup",
  "backup_target", "backup_drive_folder_id", "backup_retention_days", "backup_schedule_cron",
  "sms_provider", "whatsapp_phone_number_id",
  "bot_llm_enabled",
  "disabled_nav_items",
]);

// ── Encrypted credential columns ──
const SECRET_COLS = new Set([
  "backup_credentials", "whatsapp_api_token", "sms_api_key", "brevo_api_key", "telegram_bot_token",
]);

// ── Helper: ensure settings row exists, return it ──
async function getOrInitSettings(agencyId) {
  const { data: existing } = await supabase
    .from("agency_settings").select("*").eq("agency_id", agencyId).single();
  if (existing) return existing;

  // First time — insert default row
  const { data: created } = await supabase
    .from("agency_settings").insert({ agency_id: agencyId }).select().single();
  return created;
}

// ── Sanitize: strip/mask secret fields before returning to client ──
function sanitizeForResponse(row) {
  const out = { ...row };
  for (const col of SECRET_COLS) {
    if (out[col]) {
      out[col] = "***configured***";
      out[`${col}_set`] = true;
    } else {
      out[col] = null;
      out[`${col}_set`] = false;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════
// GET / — read settings
// ════════════════════════════════════════════════════════════
router.get("/", asyncHandler(async (req, res) => {
  const settings = await getOrInitSettings(req.user.agency_id);
  if (!settings) return res.status(500).json({ error: "Settings load করা যায়নি" });
  res.json(sanitizeForResponse(settings));
}));

// ════════════════════════════════════════════════════════════
// PATCH / — update non-secret fields
// ════════════════════════════════════════════════════════════
router.patch("/", asyncHandler(async (req, res) => {
  const updates = {};
  for (const [key, val] of Object.entries(req.body || {})) {
    if (PUBLIC_PATCH_COLS.has(key)) {
      updates[key] = val;
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "কোনো valid field দেননি" });
  }
  updates.updated_at = new Date().toISOString();

  // Ensure row exists first
  await getOrInitSettings(req.user.agency_id);

  const { data, error } = await supabase
    .from("agency_settings").update(updates).eq("agency_id", req.user.agency_id).select().single();

  if (error) {
    console.error("[agency-settings PATCH]", error.message);
    return res.status(500).json({ error: "সংরক্ষণ ব্যর্থ" });
  }

  // Invalidate per-agency caches that may have read settings.
  // navGuard caches disabled_nav_items for 60s; force-refresh on save.
  if (Object.prototype.hasOwnProperty.call(updates, "disabled_nav_items")) {
    try {
      const { invalidateAgencyNav } = require("../middleware/agencyNavGuard");
      invalidateAgencyNav(req.user.agency_id);
    } catch { /* non-fatal */ }
  }

  res.json(sanitizeForResponse(data));
}));

// ════════════════════════════════════════════════════════════
// PATCH /credentials — update encrypted secret fields
// Body shape: { field: "brevo_api_key", value: "xkeysib-..." }
// To clear: { field: "brevo_api_key", value: null }
// ════════════════════════════════════════════════════════════
router.patch("/credentials", asyncHandler(async (req, res) => {
  const { field, value } = req.body || {};
  if (!field || !SECRET_COLS.has(field)) {
    return res.status(400).json({ error: "অননুমোদিত field" });
  }
  await getOrInitSettings(req.user.agency_id);

  const stored = (value === null || value === "")
    ? null
    : encrypt(String(value));

  const { error } = await supabase
    .from("agency_settings")
    .update({ [field]: stored, updated_at: new Date().toISOString() })
    .eq("agency_id", req.user.agency_id);

  if (error) {
    console.error("[agency-settings credentials]", error.message);
    return res.status(500).json({ error: "সংরক্ষণ ব্যর্থ" });
  }
  res.json({ field, configured: !!stored });
}));

// ════════════════════════════════════════════════════════════
// POST /test-channel — send a test notification
// Body: { channel: "email"|"telegram", destination: "you@x.com" }
// ════════════════════════════════════════════════════════════
router.post("/test-channel", asyncHandler(async (req, res) => {
  const { channel, destination } = req.body || {};
  if (!["email", "telegram"].includes(channel)) {
    return res.status(400).json({ error: "channel email বা telegram হতে হবে" });
  }
  if (!destination) {
    return res.status(400).json({ error: "destination দিন" });
  }

  // Use a generic test template inline (not in TEMPLATES — to keep registry small)
  const result = await notify({
    agencyId: req.user.agency_id,
    userId: req.user.id,
    channel,
    to: channel === "email"
      ? [{ email: destination, name: req.user.email || "" }]
      : [destination],
    template: "anomaly_alert",  // reusing this template for the test
    data: {
      ruleType: "channel_test",
      actorName: "AgencyOS Settings",
      details: { message: "এটা একটা test alert। আপনি যদি এটা পান, channel ঠিকভাবে কাজ করছে।" },
      agencyName: "Test",
    },
  });

  if (result.failed > 0) {
    return res.status(502).json({ ok: false, errors: result.errors });
  }
  res.json({ ok: true, sent: result.sent });
}));

module.exports = router;
