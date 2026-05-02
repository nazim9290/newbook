/**
 * anomaly.js — Anomaly Alert / Security Watchdog endpoints
 *
 * Mounted at /api/anomaly
 *
 * Routes:
 *   GET  /events           — paginated event log (filter rule_type, ack)
 *   POST /events/:id/ack   — mark event acknowledged
 *   GET  /rules            — list rules
 *   PATCH /rules/:id       — toggle enabled, change threshold/cooldown
 *   POST /rules/:id/test   — trigger a fake event (verify alert delivery)
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { dispatchToTopic } = require("../lib/notify");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

// GET /events?page=&limit=&rule_type=&unack=true
router.get("/events", requireOwner, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const offset = (page - 1) * limit;

  const where = ["agency_id = $1"];
  const params = [req.user.agency_id];
  if (req.query.rule_type) {
    where.push(`rule_type = $${params.length + 1}`);
    params.push(req.query.rule_type);
  }
  if (req.query.unack === "true") {
    where.push(`acknowledged_at IS NULL`);
  }

  params.push(limit); params.push(offset);
  const { rows: items } = await supabase.pool.query(`
    SELECT e.*, u.name AS actor_name, u.email AS actor_email
    FROM anomaly_events e
    LEFT JOIN users u ON u.id = e.triggered_by_user
    WHERE ${where.join(" AND ")}
    ORDER BY e.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  res.json({ page, limit, items });
}));

// POST /events/:id/ack
router.post("/events/:id/ack", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `UPDATE anomaly_events
     SET acknowledged_at = NOW(), acknowledged_by = $1
     WHERE id = $2 AND agency_id = $3
     RETURNING id`,
    [req.user.id, req.params.id, req.user.agency_id]
  );
  if (!rows.length) return res.status(404).json({ error: "Event পাওয়া যায়নি" });
  res.json({ ok: true, id: rows[0].id });
}));

// GET /rules
router.get("/rules", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT * FROM anomaly_rules WHERE agency_id = $1 ORDER BY rule_type`,
    [req.user.agency_id]
  );
  res.json(rows);
}));

// PATCH /rules/:id
router.patch("/rules/:id", requireOwner, asyncHandler(async (req, res) => {
  const allowed = ["enabled", "threshold", "cooldown_minutes", "notes"];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "কোনো valid field দেননি" });
  }
  updates.updated_at = new Date().toISOString();

  const setParts = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(", ");
  const params = [...Object.values(updates), req.params.id, req.user.agency_id];

  const { rows } = await supabase.pool.query(
    `UPDATE anomaly_rules SET ${setParts}
     WHERE id = $${Object.keys(updates).length + 1} AND agency_id = $${Object.keys(updates).length + 2}
     RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Rule পাওয়া যায়নি" });
  res.json(rows[0]);
}));

// POST /rules/:id/test — fake-fire to verify channel works
router.post("/rules/:id/test", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT * FROM anomaly_rules WHERE id = $1 AND agency_id = $2`,
    [req.params.id, req.user.agency_id]
  );
  if (!rows.length) return res.status(404).json({ error: "Rule পাওয়া যায়নি" });
  const rule = rows[0];

  const { rows: a } = await supabase.pool.query(`SELECT name FROM agencies WHERE id = $1`, [req.user.agency_id]);
  const dispatch = await dispatchToTopic({
    agencyId: req.user.agency_id,
    topic: "anomaly",
    template: "anomaly_alert",
    data: {
      ruleType: `${rule.rule_type} (TEST)`,
      actorName: req.user.email || "test trigger",
      details: { test: true, message: "এটা একটা test event। চ্যানেল ঠিক আছে যদি আপনি এটা পান।" },
      agencyName: a[0]?.name,
    },
  });
  res.json({ ok: dispatch.sent > 0, sent: dispatch.sent, failed: dispatch.failed, errors: dispatch.errors });
}));

module.exports = router;
