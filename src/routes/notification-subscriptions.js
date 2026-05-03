/**
 * notification-subscriptions.js — User opt-in/out for alert topics
 *
 * Mounted at /api/notification-subscriptions
 *
 * Routes:
 *   GET  /         — current user's subscriptions
 *   POST /         — create a new subscription
 *   DELETE /:id    — disable a subscription
 *   POST /quick-setup — convenience: subscribe current user to "all" via their email
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const VALID_CHANNELS = new Set(["email", "telegram", "push", "sms", "whatsapp"]);
const VALID_TOPICS = new Set(["all", "doc_expiry", "anomaly", "backup_failed", "visa_granted", "payment", "feedback_invite", "daily_summary"]);

// GET / — current user's subs
router.get("/", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT id, channel, destination, topic, enabled, metadata, created_at
     FROM notification_subscriptions
     WHERE user_id = $1
     ORDER BY topic, channel`,
    [req.user.id]
  );
  res.json(rows);
}));

// POST / — create or upsert
router.post("/", asyncHandler(async (req, res) => {
  const { channel, destination, topic, metadata } = req.body || {};
  if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: "Invalid channel" });
  if (!VALID_TOPICS.has(topic)) return res.status(400).json({ error: "Invalid topic" });
  if (!destination || !destination.trim()) return res.status(400).json({ error: "destination দিন" });

  const { rows } = await supabase.pool.query(`
    INSERT INTO notification_subscriptions (agency_id, user_id, channel, destination, topic, enabled, metadata)
    VALUES ($1, $2, $3, $4, $5, TRUE, $6)
    ON CONFLICT (user_id, channel, destination, topic)
      DO UPDATE SET enabled = TRUE, metadata = EXCLUDED.metadata, updated_at = NOW()
    RETURNING *
  `, [req.user.agency_id, req.user.id, channel, destination.trim(), topic, metadata || null]);
  res.status(201).json(rows[0]);
}));

// DELETE /:id — disable (don't hard-delete; preserve audit)
router.delete("/:id", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `UPDATE notification_subscriptions SET enabled = FALSE, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));

// POST /quick-setup — sub current user to all topics via their email
router.post("/quick-setup", asyncHandler(async (req, res) => {
  const { rows: u } = await supabase.pool.query(
    `SELECT email FROM users WHERE id = $1`, [req.user.id]
  );
  const email = u[0]?.email;
  if (!email) return res.status(400).json({ error: "User-এর email নেই" });

  await supabase.pool.query(`
    INSERT INTO notification_subscriptions (agency_id, user_id, channel, destination, topic, enabled)
    VALUES ($1, $2, 'email', $3, 'all', TRUE)
    ON CONFLICT (user_id, channel, destination, topic)
      DO UPDATE SET enabled = TRUE, updated_at = NOW()
  `, [req.user.agency_id, req.user.id, email]);

  res.json({ ok: true, email });
}));

module.exports = router;
