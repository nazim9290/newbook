/**
 * backup.js — Offsite backup admin endpoints
 *
 * Mounted at /api/backup
 *
 * Routes:
 *   GET  /status          — read sanitized status (any owner/super_admin can see)
 *   PATCH /config         — super_admin only: target/folder/retention/enabled/cron
 *   PATCH /credentials    — super_admin only: provide service account JSON
 *   POST /test-connection — super_admin only: verify creds
 *   POST /run-now         — super_admin only: trigger backup immediately
 *   GET  /list            — super_admin only: list remote backup files
 */

const express = require("express");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const offsite = require("../lib/offsiteBackup");

const router = express.Router();

const READ_ROLES = new Set(["super_admin", "owner", "admin"]);
const WRITE_ROLES = new Set(["super_admin"]);

router.use(auth);

function requireRead(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!READ_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}
function requireWrite(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!WRITE_ROLES.has(role)) return res.status(403).json({ error: "শুধু super_admin এই কাজ করতে পারে" });
  next();
}

// GET /status — visible to all owners (read-only)
router.get("/status", requireRead, asyncHandler(async (req, res) => {
  const status = await offsite.getStatus();
  res.json(status);
}));

// PATCH /config — super_admin
router.patch("/config", requireWrite, asyncHandler(async (req, res) => {
  const { target, folderId, retentionDays, enabled, scheduleCron } = req.body || {};
  const status = await offsite.saveConfig({ target, folderId, retentionDays, enabled, scheduleCron });
  res.json(status);
}));

// PATCH /credentials — super_admin
// Body: { credentials: <object|null> } — service account JSON
router.patch("/credentials", requireWrite, asyncHandler(async (req, res) => {
  const { credentials } = req.body || {};
  if (credentials !== null && (!credentials || typeof credentials !== "object")) {
    return res.status(400).json({ error: "service account JSON object দিন (বা null দিয়ে clear করুন)" });
  }
  const status = await offsite.saveConfig({ credentials });
  res.json(status);
}));

// POST /test-connection — super_admin
router.post("/test-connection", requireWrite, asyncHandler(async (req, res) => {
  try {
    const result = await offsite.testConnection();
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}));

// POST /run-now — super_admin (sync trigger)
router.post("/run-now", requireWrite, asyncHandler(async (req, res) => {
  try {
    const result = await offsite.runBackup();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}));

// GET /list — super_admin
router.get("/list", requireWrite, asyncHandler(async (req, res) => {
  try {
    const files = await offsite.listBackups();
    res.json({ count: files.length, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
