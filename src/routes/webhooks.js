/**
 * webhooks.js — Inbound Webhook Hub (Phase 4 F15)
 *
 * Mounted at /api/webhooks
 *
 * Inbound endpoint (no auth, token-based):
 *   POST /inbound/:token       — external systems POST data; we map → create visitor/task
 *
 * Auth (owner) — manage webhook configs:
 *   GET    /                   — list configured webhooks
 *   POST   /                   — create new webhook
 *   PATCH  /:id                — update mapping/enable
 *   DELETE /:id                — delete (cascade events)
 *   GET    /:id/events         — recent inbound events
 */

const express = require("express");
const crypto = require("crypto");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();

const OWNER_ROLES = new Set(["super_admin", "owner", "admin"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

function genToken() {
  return crypto.randomBytes(20).toString("base64url");
}

// Get nested value from object using dot notation
function getPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

// ════════════════════════════════════════════════════════════
// PUBLIC inbound endpoint — no auth, token in URL
// ════════════════════════════════════════════════════════════
router.post("/inbound/:token", asyncHandler(async (req, res) => {
  const token = req.params.token;
  const { rows: hooks } = await supabase.pool.query(
    `SELECT * FROM inbound_webhooks WHERE webhook_token = $1 AND enabled = TRUE LIMIT 1`,
    [token]
  );
  if (!hooks.length) return res.status(404).json({ error: "Unknown webhook" });
  const hook = hooks[0];

  let resultStatus = "received";
  let resultMessage = null;
  let createdRecordId = null;

  try {
    if (hook.target_action === "create_visitor") {
      const mapping = hook.field_mapping || {};
      // Build visitor record from mapping (supports literal strings and dot-paths)
      const record = { agency_id: hook.agency_id, source: hook.source_type || "Webhook" };
      const fields = ["name", "phone", "email", "notes", "country", "address"];
      for (const f of fields) {
        const path = mapping[f];
        if (!path) continue;
        const val = path.startsWith("$.") ? getPath(req.body, path.slice(2)) : path;
        if (val !== undefined && val !== null) record[f] = String(val);
      }
      // Phone is required for visitors; reject if missing
      if (!record.phone) {
        resultStatus = "failed";
        resultMessage = "phone field missing — check field_mapping";
      } else {
        // Dedupe by phone
        const { rows: dup } = await supabase.pool.query(
          `SELECT id FROM visitors WHERE agency_id = $1 AND phone = $2 LIMIT 1`,
          [hook.agency_id, record.phone]
        );
        if (dup.length) {
          resultStatus = "duplicate";
          resultMessage = "Visitor exists";
          createdRecordId = dup[0].id;
        } else {
          const cols = Object.keys(record);
          const vals = cols.map((_, i) => `$${i + 1}`);
          const { rows: created } = await supabase.pool.query(
            `INSERT INTO visitors (${cols.join(", ")}) VALUES (${vals.join(", ")}) RETURNING id`,
            cols.map((c) => record[c])
          );
          createdRecordId = created[0].id;
          resultStatus = "created";
        }
      }
    } else if (hook.target_action === "log_only") {
      resultStatus = "logged";
    } else {
      resultStatus = "failed";
      resultMessage = `Unknown target_action: ${hook.target_action}`;
    }
  } catch (err) {
    resultStatus = "failed";
    resultMessage = err.message;
  }

  // Always log the inbound event
  await supabase.pool.query(`
    INSERT INTO webhook_events (webhook_id, agency_id, payload, result_status, result_message, created_record_id, ip, user_agent)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
  `, [hook.id, hook.agency_id, JSON.stringify(req.body || {}), resultStatus, resultMessage, createdRecordId, req.ip, req.headers["user-agent"]]);

  res.json({ ok: resultStatus !== "failed", status: resultStatus, message: resultMessage });
}));

// ════════════════════════════════════════════════════════════
// AUTH endpoints
// ════════════════════════════════════════════════════════════
router.use(auth);

router.get("/", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT id, name, source_type, target_action, field_mapping, enabled, created_at, webhook_token
     FROM inbound_webhooks WHERE agency_id = $1 ORDER BY created_at DESC`,
    [req.user.agency_id]
  );
  // Build full URL for each
  const host = req.get("host");
  const proto = req.protocol;
  for (const r of rows) {
    r.inbound_url = `${proto}://${host}/api/webhooks/inbound/${r.webhook_token}`;
  }
  res.json(rows);
}));

router.post("/", requireOwner, asyncHandler(async (req, res) => {
  const { name, source_type, target_action, field_mapping } = req.body || {};
  if (!name || !target_action) return res.status(400).json({ error: "name + target_action দিন" });
  const token = genToken();
  const { rows } = await supabase.pool.query(`
    INSERT INTO inbound_webhooks (agency_id, name, source_type, target_action, field_mapping, webhook_token, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *
  `, [req.user.agency_id, name, source_type || "generic_json", target_action, JSON.stringify(field_mapping || {}), token, req.user.id]);
  const row = rows[0];
  row.inbound_url = `${req.protocol}://${req.get("host")}/api/webhooks/inbound/${row.webhook_token}`;
  res.status(201).json(row);
}));

router.patch("/:id", requireOwner, asyncHandler(async (req, res) => {
  const allowed = ["name", "source_type", "target_action", "field_mapping", "enabled"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid field" });
  const setParts = Object.keys(updates).map((k, i) => {
    if (k === "field_mapping") return `${k} = $${i + 1}::jsonb`;
    return `${k} = $${i + 1}`;
  }).join(", ");
  const params = Object.entries(updates).map(([k, v]) => k === "field_mapping" ? JSON.stringify(v) : v);
  params.push(req.params.id, req.user.agency_id);
  const { rows } = await supabase.pool.query(
    `UPDATE inbound_webhooks SET ${setParts}
     WHERE id = $${params.length - 1} AND agency_id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

router.delete("/:id", requireOwner, asyncHandler(async (req, res) => {
  await supabase.pool.query(
    `DELETE FROM inbound_webhooks WHERE id = $1 AND agency_id = $2`,
    [req.params.id, req.user.agency_id]
  );
  res.json({ ok: true });
}));

router.get("/:id/events", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT * FROM webhook_events
     WHERE webhook_id = $1 AND agency_id = $2
     ORDER BY created_at DESC LIMIT 100`,
    [req.params.id, req.user.agency_id]
  );
  res.json(rows);
}));

module.exports = router;
