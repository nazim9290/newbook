/**
 * system.js — System info endpoints (Phase 0)
 *
 * Endpoints:
 *   GET /api/system/license  → public license info (no secrets)
 *   GET /api/system/info     → instance + deployment metadata
 *
 * All routes require auth — license info shouldn't leak to anonymous callers
 * even though it contains no secrets.
 *
 * Future (Phase 2): /api/system/check-update, /api/system/update-now
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const auth = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');
const licensing = require('../lib/licensing');
const updateClient = require('../lib/updateClient');

const router = express.Router();
router.use(auth);

// ── Owner/admin role gate — system endpoints aren't for staff ──
function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === 'super_admin' || role === 'owner' || role === 'admin') return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}

router.get('/license', asyncHandler(async (req, res) => {
  const info = await licensing.getPublicInfo();
  res.json(info);
}));

router.get('/info', asyncHandler(async (req, res) => {
  const lic = await licensing.getPublicInfo();
  res.json({
    instance_id: licensing.INSTANCE_ID,
    deployment_mode: licensing.DEPLOYMENT_MODE,
    node_env: process.env.NODE_ENV || 'production',
    current_version: updateClient.getCurrentVersion(),
    license_status: lic.status,
    update_channel: lic.update_channel,
    is_multi_tenant: lic.is_multi_tenant,
    server_time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  });
}));

// ── Phase 2: Update Distribution ───────────────────────────────────────
router.get('/check-update', requireAdmin, asyncHandler(async (req, res) => {
  const info = await updateClient.checkForUpdate();
  res.json(info);
}));

/**
 * POST /api/system/update-now
 * Triggers /home/agencybook/safe-update.sh in background.
 * Only owner/admin/super-admin can call. Best-effort: spawns detached
 * process; client should poll /info.uptime_seconds to know when restart
 * completed.
 */
router.post('/update-now', requireAdmin, asyncHandler(async (req, res) => {
  const updateScript = process.env.UPDATE_SCRIPT_PATH || '/home/agencybook/safe-update.sh';
  try {
    const child = spawn('bash', [updateScript, 'backend'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.json({
      ok: true,
      message: 'Update started — system will restart shortly. Reload this page in 60-90 seconds.',
      script: updateScript,
      pid: child.pid,
    });
  } catch (err) {
    console.error('[update-now] spawn failed:', err.message);
    res.status(500).json({ error: 'Update trigger failed: ' + err.message });
  }
}));

module.exports = router;
