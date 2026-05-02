/**
 * webPush.js — Web Push notification helper (Phase 3 Feature 8)
 *
 * Uses VAPID auth (public key shared with frontend, private key on server).
 *
 * USAGE
 * -----
 *   const { sendPush, sendToTopic } = require("./webPush");
 *   await sendPush(userId, { title: "...", body: "...", url: "/students/abc" });
 *
 * Pruning
 * -------
 * If a subscription returns 410 Gone or 404 Not Found, we mark it disabled
 * (browser revoked it). Future pushes to that user skip it.
 */

const webPushLib = require("web-push");
const supabase = require("./db");
const pool = supabase.pool;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:noreply@agencybook.net";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn("[webPush] VAPID keys not set — push disabled");
    return false;
  }
  webPushLib.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
  return true;
}

/**
 * Save a new subscription (browser → backend after Notification permission).
 */
async function subscribe({ agencyId, userId, subscription, userAgent, topics }) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error("Invalid subscription object");
  }
  await pool.query(`
    INSERT INTO push_subscriptions (agency_id, user_id, endpoint, p256dh, auth, user_agent, topics, enabled, last_seen_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
    ON CONFLICT (user_id, endpoint) DO UPDATE
      SET enabled = TRUE, last_seen_at = NOW(), topics = EXCLUDED.topics, user_agent = EXCLUDED.user_agent
  `, [
    agencyId, userId, subscription.endpoint,
    subscription.keys.p256dh, subscription.keys.auth,
    userAgent || null, topics || ['all'],
  ]);
}

/**
 * Unsubscribe a single endpoint.
 */
async function unsubscribe({ userId, endpoint }) {
  await pool.query(`
    UPDATE push_subscriptions SET enabled = FALSE
    WHERE user_id = $1 AND endpoint = $2
  `, [userId, endpoint]);
}

/**
 * Send to a single user (all their active subscriptions).
 */
async function sendPush(userId, payload) {
  if (!ensureConfigured()) return { sent: 0, failed: 0, reason: "not_configured" };

  const { rows } = await pool.query(
    `SELECT * FROM push_subscriptions WHERE user_id = $1 AND enabled = TRUE`,
    [userId]
  );
  let sent = 0, failed = 0;
  for (const sub of rows) {
    try {
      await webPushLib.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      failed++;
      // Browser revoked — disable this subscription
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(
          `UPDATE push_subscriptions SET enabled = FALSE WHERE id = $1`, [sub.id]
        );
      } else {
        console.error("[webPush] send error:", err.statusCode, err.body || err.message);
      }
    }
  }
  return { sent, failed };
}

/**
 * Send to all users in agency subscribed to a topic.
 */
async function sendToTopic({ agencyId, topic, payload }) {
  if (!ensureConfigured()) return { sent: 0, failed: 0, reason: "not_configured" };

  const { rows } = await pool.query(`
    SELECT * FROM push_subscriptions
    WHERE agency_id = $1
      AND enabled = TRUE
      AND ($2 = ANY(topics) OR 'all' = ANY(topics))
  `, [agencyId, topic]);

  let sent = 0, failed = 0;
  for (const sub of rows) {
    try {
      await webPushLib.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(`UPDATE push_subscriptions SET enabled = FALSE WHERE id = $1`, [sub.id]);
      }
    }
  }
  return { sent, failed };
}

function getPublicKey() {
  return VAPID_PUBLIC || null;
}

module.exports = {
  subscribe,
  unsubscribe,
  sendPush,
  sendToTopic,
  getPublicKey,
};
