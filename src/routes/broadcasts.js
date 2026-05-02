/**
 * broadcasts.js — Bulk WhatsApp/SMS broadcast (Phase 2 Feature 4)
 *
 * Mounted at /api/broadcasts
 *
 * STATUS: Schema + admin/preview endpoints complete.
 * SENDING: Disabled until owner configures WhatsApp/SMS provider creds.
 *          Calling /campaigns/:id/send returns 503 with config-required error.
 *
 * Routes:
 *   GET/POST   /templates                — message template CRUD
 *   PATCH/DELETE /templates/:id
 *   POST   /campaigns/preview            — count audience without saving
 *   GET    /campaigns                    — list
 *   POST   /campaigns                    — create draft
 *   POST   /campaigns/:id/send           — start sending (BLOCKED if not configured)
 *   GET    /campaigns/:id                — campaign detail with progress
 *   POST   /campaigns/:id/cancel
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { decrypt } = require("../lib/crypto");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

// ═══════════════════════════════════════════════════════════
// MESSAGE TEMPLATES
// ═══════════════════════════════════════════════════════════
router.get("/templates", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT * FROM message_templates WHERE agency_id = $1 ORDER BY created_at DESC`,
    [req.user.agency_id]
  );
  res.json(rows);
}));

router.post("/templates", requireOwner, asyncHandler(async (req, res) => {
  const { name, channel, body, whatsapp_template_name, category } = req.body || {};
  if (!name || !channel || !body) return res.status(400).json({ error: "name, channel, body দিন" });
  if (!["whatsapp", "sms", "email"].includes(channel)) return res.status(400).json({ error: "Invalid channel" });
  const { rows } = await supabase.pool.query(`
    INSERT INTO message_templates (agency_id, name, channel, body, whatsapp_template_name, category, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
  `, [req.user.agency_id, name, channel, body, whatsapp_template_name || null, category || null, req.user.id]);
  res.status(201).json(rows[0]);
}));

router.patch("/templates/:id", requireOwner, asyncHandler(async (req, res) => {
  const allowed = ["name", "body", "whatsapp_template_name", "category"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid field" });
  updates.updated_at = new Date().toISOString();
  const setParts = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(", ");
  const params = [...Object.values(updates), req.params.id, req.user.agency_id];
  const { rows } = await supabase.pool.query(
    `UPDATE message_templates SET ${setParts}
     WHERE id = $${Object.keys(updates).length + 1} AND agency_id = $${Object.keys(updates).length + 2}
     RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

router.delete("/templates/:id", requireOwner, asyncHandler(async (req, res) => {
  await supabase.pool.query(
    `DELETE FROM message_templates WHERE id = $1 AND agency_id = $2`,
    [req.params.id, req.user.agency_id]
  );
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════
// AUDIENCE PREVIEW
// Body: { audience: { type: "visitor"|"student", filter: {...} } }
// Returns matched count + estimated cost
// ═══════════════════════════════════════════════════════════
router.post("/campaigns/preview", requireOwner, asyncHandler(async (req, res) => {
  const { audience, channel } = req.body || {};
  if (!audience || !audience.type) return res.status(400).json({ error: "audience.type দিন" });

  const where = ["agency_id = $1", "phone IS NOT NULL", "phone != ''"];
  const params = [req.user.agency_id];
  let table = audience.type === "visitor" ? "visitors" : "students";

  const f = audience.filter || {};
  if (f.status) { where.push(`status = $${params.length + 1}`); params.push(f.status); }
  if (f.country) { where.push(`country = $${params.length + 1}`); params.push(f.country); }
  if (f.branch) { where.push(`branch = $${params.length + 1}`); params.push(f.branch); }
  if (f.school_id && audience.type === "student") {
    where.push(`school_id = $${params.length + 1}`); params.push(f.school_id);
  }

  const { rows } = await supabase.pool.query(
    `SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${where.join(" AND ")}`,
    params
  );
  const count = rows[0]?.count || 0;

  // Cost estimation (very rough — owner customizes per provider)
  const costPerMsg = channel === "whatsapp" ? 0.05 : channel === "sms" ? 0.30 : 0;
  const estimated_cost_bdt = Math.round(count * costPerMsg * 100) / 100;

  res.json({ count, estimated_cost_bdt, channel });
}));

// ═══════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════
router.get("/campaigns", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT c.*, t.name AS template_name, t.channel, t.body
    FROM broadcast_campaigns c
    LEFT JOIN message_templates t ON t.id = c.template_id
    WHERE c.agency_id = $1
    ORDER BY c.created_at DESC LIMIT 100
  `, [req.user.agency_id]);
  res.json(rows);
}));

router.get("/campaigns/:id", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT c.*, t.name AS template_name, t.channel, t.body
    FROM broadcast_campaigns c
    LEFT JOIN message_templates t ON t.id = c.template_id
    WHERE c.id = $1 AND c.agency_id = $2
  `, [req.params.id, req.user.agency_id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

router.post("/campaigns", requireOwner, asyncHandler(async (req, res) => {
  const { name, template_id, audience, scheduled_at } = req.body || {};
  if (!name || !template_id || !audience) {
    return res.status(400).json({ error: "name, template_id, audience দিন" });
  }
  // Verify template exists in agency
  const { rows: tpl } = await supabase.pool.query(
    `SELECT id FROM message_templates WHERE id = $1 AND agency_id = $2`,
    [template_id, req.user.agency_id]
  );
  if (!tpl.length) return res.status(404).json({ error: "Template পাওয়া যায়নি" });

  const { rows } = await supabase.pool.query(`
    INSERT INTO broadcast_campaigns (agency_id, name, template_id, audience_filter, status, scheduled_at, created_by)
    VALUES ($1, $2, $3, $4::jsonb, 'draft', $5, $6) RETURNING *
  `, [req.user.agency_id, name, template_id, JSON.stringify(audience), scheduled_at || null, req.user.id]);
  res.status(201).json(rows[0]);
}));

// POST /:id/send — BLOCKED until provider creds configured
router.post("/campaigns/:id/send", requireOwner, asyncHandler(async (req, res) => {
  // Check feature flag + creds
  const { rows: settings } = await supabase.pool.query(
    `SELECT enable_broadcast, whatsapp_api_token, sms_api_key, broadcast_daily_limit, broadcast_sent_today, broadcast_reset_date
     FROM agency_settings WHERE agency_id = $1`, [req.user.agency_id]
  );
  if (!settings.length || !settings[0].enable_broadcast) {
    return res.status(503).json({
      error: "Broadcast feature বন্ধ — Settings > Owner Tools-এ enable করুন এবং WhatsApp/SMS provider creds configure করুন",
      code: "BROADCAST_DISABLED",
    });
  }

  const s = settings[0];
  // Daily limit check
  const today = new Date().toISOString().slice(0, 10);
  if (s.broadcast_reset_date !== today) {
    await supabase.pool.query(
      `UPDATE agency_settings SET broadcast_sent_today = 0, broadcast_reset_date = $1 WHERE agency_id = $2`,
      [today, req.user.agency_id]
    );
  }

  // Get campaign + template
  const { rows: camps } = await supabase.pool.query(`
    SELECT c.*, t.channel, t.body, t.whatsapp_template_name
    FROM broadcast_campaigns c
    LEFT JOIN message_templates t ON t.id = c.template_id
    WHERE c.id = $1 AND c.agency_id = $2
  `, [req.params.id, req.user.agency_id]);
  if (!camps.length) return res.status(404).json({ error: "Campaign পাওয়া যায়নি" });
  const camp = camps[0];

  if (camp.status !== "draft") {
    return res.status(400).json({ error: `Campaign already ${camp.status}` });
  }

  const channel = camp.channel;
  if (channel === "whatsapp" && !s.whatsapp_api_token) {
    return res.status(503).json({ error: "WhatsApp API token configure করা নেই", code: "WHATSAPP_NOT_CONFIGURED" });
  }
  if (channel === "sms" && !s.sms_api_key) {
    return res.status(503).json({ error: "SMS API key configure করা নেই", code: "SMS_NOT_CONFIGURED" });
  }

  // Resolve audience to phone numbers
  const f = camp.audience_filter || {};
  const aType = f.type || "visitor";
  const where = ["agency_id = $1", "phone IS NOT NULL", "phone != ''"];
  const params = [req.user.agency_id];
  if (f.filter?.status) { where.push(`status = $${params.length + 1}`); params.push(f.filter.status); }
  if (f.filter?.country) { where.push(`country = $${params.length + 1}`); params.push(f.filter.country); }
  if (f.filter?.branch) { where.push(`branch = $${params.length + 1}`); params.push(f.filter.branch); }
  if (f.filter?.school_id && aType === "student") {
    where.push(`school_id = $${params.length + 1}`); params.push(f.filter.school_id);
  }

  const tableName = aType === "visitor" ? "visitors" : "students";
  const { rows: recipients } = await supabase.pool.query(
    `SELECT id, phone, COALESCE(name_en, name) AS name FROM "${tableName}" WHERE ${where.join(" AND ")}`,
    params
  );

  // Daily limit check
  const remaining = (s.broadcast_daily_limit || 1000) - (s.broadcast_sent_today || 0);
  if (recipients.length > remaining) {
    return res.status(429).json({
      error: `Daily limit exceed হবে: ${recipients.length} > remaining ${remaining}`,
      code: "DAILY_LIMIT_EXCEEDED",
      remaining, requested: recipients.length,
    });
  }

  // Insert recipients into broadcast_recipients
  for (const r of recipients) {
    await supabase.pool.query(
      `INSERT INTO broadcast_recipients (campaign_id, recipient_type, recipient_id, phone, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [camp.id, aType, r.id, r.phone]
    );
  }

  await supabase.pool.query(
    `UPDATE broadcast_campaigns
     SET status = 'sending', total_recipients = $1, started_at = NOW()
     WHERE id = $2`,
    [recipients.length, camp.id]
  );

  // ⚠️ Actual sending NOT implemented in this iteration —
  // queue worker would pick up 'sending' campaigns and process recipients.
  // For now, mark as 'queued' so admin knows it's awaiting provider integration.
  res.json({
    ok: true,
    queued: recipients.length,
    note: "Recipients queued. Sending pipeline will activate when WhatsApp/SMS provider integration completes.",
  });
}));

router.post("/campaigns/:id/cancel", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `UPDATE broadcast_campaigns
     SET status = 'cancelled'
     WHERE id = $1 AND agency_id = $2 AND status IN ('draft','sending')
     RETURNING *`,
    [req.params.id, req.user.agency_id]
  );
  if (!rows.length) return res.status(404).json({ error: "Cannot cancel" });
  res.json(rows[0]);
}));

module.exports = router;
