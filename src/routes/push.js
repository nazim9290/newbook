/**
 * push.js — Web Push subscription + test endpoints
 *
 * Mounted at /api/push
 *
 * Routes:
 *   GET  /vapid-public        — public key for frontend (no auth needed)
 *   POST /subscribe           — store subscription
 *   POST /unsubscribe         — disable an endpoint
 *   POST /test                — send a test push to current user
 */

const express = require("express");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const webPush = require("../lib/webPush");

const router = express.Router();

// Public — no auth (frontend needs key before login)
router.get("/vapid-public", (req, res) => {
  const key = webPush.getPublicKey();
  if (!key) return res.status(503).json({ error: "Push not configured" });
  res.json({ publicKey: key });
});

router.use(auth);

router.post("/subscribe", asyncHandler(async (req, res) => {
  const { subscription, topics } = req.body || {};
  if (!subscription) return res.status(400).json({ error: "subscription object দিন" });
  await webPush.subscribe({
    agencyId: req.user.agency_id,
    userId: req.user.id,
    subscription,
    userAgent: req.headers["user-agent"],
    topics: Array.isArray(topics) && topics.length ? topics : ["all"],
  });
  res.json({ ok: true });
}));

router.post("/unsubscribe", asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint দিন" });
  await webPush.unsubscribe({ userId: req.user.id, endpoint });
  res.json({ ok: true });
}));

router.post("/test", asyncHandler(async (req, res) => {
  const result = await webPush.sendPush(req.user.id, {
    title: "AgencyOS Test",
    body: "Push notification কাজ করছে! ✓",
    icon: "/pwa-192x192.png",
    url: "/",
  });
  if (result.sent === 0) {
    return res.status(404).json({ ok: false, error: "কোনো active subscription নেই", ...result });
  }
  res.json({ ok: true, ...result });
}));

module.exports = router;
