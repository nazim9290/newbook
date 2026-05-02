/**
 * ops.js — Phase 3 Operator Console
 *
 * Two roles for this route file:
 *
 *   1. INGRESS (called by Tier A/B/C instances):
 *      POST /api/ops/heartbeat
 *      Body: { instance_id, version, license_status, agencies_count, ... }
 *      Auth: license_key in X-License-Key header
 *      Writes a row to instance_heartbeats.
 *
 *   2. DASHBOARD (called by central super-admin UI):
 *      GET  /api/ops/instances              — fleet overview (last_seen view)
 *      GET  /api/ops/instances/:id/history  — time-series for one instance
 *      Auth: super_admin role.
 *
 * Why one file: keeps related ingress + read endpoints together. The two
 * groups don't share middleware — ingress trusts license_key, dashboard
 * trusts JWT.
 */

const express = require('express');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// ── INGRESS — license-key authenticated ────────────────────────────────
router.post('/heartbeat', asyncHandler(async (req, res) => {
  const licenseKey = req.headers['x-license-key'];
  if (!licenseKey) return res.status(401).json({ error: 'X-License-Key required' });

  // Look up license to validate the key + bind instance_id from license row
  const { data: license, error } = await supabase.from('licenses')
    .select('instance_id, status')
    .eq('license_key', licenseKey)
    .single();

  if (error || !license) {
    return res.status(401).json({ error: 'invalid license key' });
  }

  // Body fields — any may be missing, default to null
  const {
    deployment_mode = null,
    hostname = null,
    version = null,
    agencies_count = 0,
    users_count = 0,
    storage_mb = null,
    uptime_seconds = null,
    memory_mb = null,
    error_count_24h = 0,
  } = req.body || {};

  await supabase.pool.query(
    `INSERT INTO instance_heartbeats (
       instance_id, deployment_mode, hostname, version, license_status,
       agencies_count, users_count, storage_mb, uptime_seconds, memory_mb,
       error_count_24h, ip_address
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      license.instance_id, deployment_mode, hostname, version, license.status,
      agencies_count, users_count, storage_mb, uptime_seconds, memory_mb,
      error_count_24h, req.ip,
    ]
  );

  res.json({ ok: true, recorded_at: new Date().toISOString() });
}));

// ── DASHBOARD — super_admin only ───────────────────────────────────────
router.use(auth);
router.use((req, res, next) => {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin access only' });
  }
  next();
});

router.get('/instances', asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT instance_id, deployment_mode, hostname, version, license_status,
           agencies_count, users_count, storage_mb, uptime_seconds, memory_mb,
           error_count_24h, reported_at, seconds_since_heartbeat
    FROM v_instance_last_seen
    ORDER BY reported_at DESC
  `);

  // Annotate with health classification
  const data = rows.map(r => ({
    ...r,
    health: classifyHealth(r),
  }));

  res.json(data);
}));

router.get('/instances/:id/history', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const hours = Math.min(parseInt(req.query.hours, 10) || 24, 168);
  const { rows } = await supabase.pool.query(
    `SELECT version, license_status, agencies_count, users_count,
            storage_mb, uptime_seconds, memory_mb, error_count_24h, reported_at
     FROM instance_heartbeats
     WHERE instance_id = $1
       AND reported_at > now() - INTERVAL '${hours} hours'
     ORDER BY reported_at DESC
     LIMIT 1000`,
    [id]
  );
  res.json(rows);
}));

function classifyHealth(r) {
  // No heartbeat in 30 min → 'down'; > 50 errors/24h or past_due license → 'warn'; else 'ok'
  if (!r.reported_at || r.seconds_since_heartbeat > 1800) return 'down';
  if (r.license_status === 'suspended' || r.license_status === 'cancelled') return 'warn';
  if ((r.error_count_24h || 0) > 50) return 'warn';
  if (r.license_status === 'past_due') return 'warn';
  return 'ok';
}

module.exports = router;
