#!/usr/bin/env node
/**
 * license-agent-stub.js — Phase 14 (skeleton).
 *
 * Runs in its own container alongside the backend on the customer's
 * hardware. Responsibilities (full impl when enterprise contract signed):
 *
 *   1. Generate hardware fingerprint (MAC+CPU+disk UUID hash)
 *   2. Phone home to license.agencybook.net every 24h
 *   3. Validate signed JWT response
 *   4. Cache JWT in Redis at key `license_jwt` for backend to read
 *   5. Track offline duration (>7 days → status=suspended)
 *   6. Receive critical-update notifications
 *
 * STATUS: stub. Logs heartbeat-style messages but doesn't yet validate
 * a real signed JWT against license.agencybook.net (that server doesn't
 * exist yet either — built when first on-prem deal closes).
 *
 * To finish:
 *   - npm install ioredis node-fetch jsonwebtoken
 *   - implement getHardwareId() reading /sys/class/dmi/id/board_serial etc.
 *   - implement license.agencybook.net signing endpoint
 *   - wire backend to read license_jwt from Redis
 */

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const LICENSE_KEY = process.env.LICENSE_KEY;
const LICENSE_SERVER = process.env.LICENSE_SERVER || 'https://license.agencybook.net';
const INSTANCE_ID = process.env.INSTANCE_ID || 'unknown';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

if (!LICENSE_KEY) {
  console.error('FATAL: LICENSE_KEY env required');
  process.exit(1);
}

function getHardwareId() {
  // Stub: real impl combines /sys/class/dmi/id/board_serial,
  // primary network MAC, /sys/class/dmi/id/product_uuid, root disk UUID.
  const components = [
    `host:${os.hostname()}`,
    `cpu:${os.cpus()[0]?.model || 'unknown'}`,
    `arch:${os.arch()}`,
  ];
  // Try board serial (Linux only)
  try {
    components.push(`board:${fs.readFileSync('/sys/class/dmi/id/board_serial', 'utf8').trim()}`);
  } catch {}
  return crypto.createHash('sha256').update(components.sort().join('|')).digest('hex');
}

async function validateLicense() {
  const hardwareId = getHardwareId();
  console.log(`[license-agent] checking license ${LICENSE_KEY.slice(0, 8)}... hardware=${hardwareId.slice(0, 12)}`);

  try {
    const res = await fetch(`${LICENSE_SERVER}/v1/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: LICENSE_KEY,
        instance_id: INSTANCE_ID,
        hardware_id: hardwareId,
        version: process.env.npm_package_version || '0.0.0',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.warn(`[license-agent] validation returned ${res.status}`);
      return;
    }

    const data = await res.json();
    console.log(`[license-agent] valid=${data.valid} status=${data.status} expires_at=${data.expires_at}`);

    // TODO: store data.signed_token in Redis at key 'license_jwt' for backend to consume
  } catch (err) {
    console.warn(`[license-agent] phone-home failed: ${err.message}`);
  }
}

console.log('[license-agent] starting (Phase 14 stub)');
console.log(`  LICENSE_SERVER: ${LICENSE_SERVER}`);
console.log(`  INSTANCE_ID:    ${INSTANCE_ID}`);
console.log(`  Check interval: ${CHECK_INTERVAL_MS / 1000 / 60 / 60}h`);

// Initial + periodic
validateLicense();
setInterval(validateLicense, CHECK_INTERVAL_MS);

// Keep alive
process.on('SIGTERM', () => { console.log('[license-agent] shutting down'); process.exit(0); });
