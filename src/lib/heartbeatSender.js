/**
 * heartbeatSender.js — Phase 3.
 *
 * Tier A/B/C instances: every 15 minutes, POST a heartbeat to the central
 * ops endpoint. Best-effort, fire-and-forget — never blocks app boot.
 *
 * Wired in app.js startup callback:
 *   require('./lib/heartbeatSender').start();
 *
 * Disabled when DEPLOYMENT_MODE=shared-saas (the central instance itself
 * doesn't need to heartbeat to itself).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const supabase = require('./db');
const licensing = require('./licensing');

const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const OPS_ENDPOINT =
  process.env.OPS_HEARTBEAT_URL || 'https://demo-api.agencybook.net/api/ops/heartbeat';

let timer = null;

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

async function gatherStats() {
  let agencies = 0, users = 0;
  try {
    const r = await supabase.pool.query('SELECT COUNT(*)::int AS c FROM agencies');
    agencies = r.rows[0]?.c || 0;
  } catch {}
  try {
    const r = await supabase.pool.query('SELECT COUNT(*)::int AS c FROM users');
    users = r.rows[0]?.c || 0;
  } catch {}

  return {
    deployment_mode: licensing.DEPLOYMENT_MODE,
    hostname: os.hostname(),
    version: getCurrentVersion(),
    agencies_count: agencies,
    users_count: users,
    uptime_seconds: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    storage_mb: null, // not measured client-side
    error_count_24h: 0, // hooked from Sentry/anomalyDetector later
  };
}

async function sendHeartbeat() {
  // Skip if shared-saas (central calls itself, redundant)
  if (licensing.DEPLOYMENT_MODE === 'shared-saas') return;

  try {
    const lic = await licensing.getCurrent();
    if (!lic.license_key) return; // No license key → can't authenticate ingress

    const stats = await gatherStats();
    await fetch(OPS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': lic.license_key,
      },
      body: JSON.stringify(stats),
      signal: AbortSignal.timeout(15000),
    }).catch(err => {
      console.warn('[heartbeat] send failed:', err.message);
    });
  } catch (err) {
    console.warn('[heartbeat] error:', err.message);
  }
}

function start() {
  if (timer) return;
  // Initial heartbeat after 60s, then every 15 min
  setTimeout(sendHeartbeat, 60 * 1000);
  timer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  console.log('[heartbeat] sender started (15 min interval)');
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, sendHeartbeat };
