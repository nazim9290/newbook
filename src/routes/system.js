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
const auth = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');
const licensing = require('../lib/licensing');

const router = express.Router();
router.use(auth);

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
    license_status: lic.status,
    update_channel: lic.update_channel,
    is_multi_tenant: lic.is_multi_tenant,
    server_time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
  });
}));

module.exports = router;
