/**
 * updateClient.js — phone-home update check (Phase 2).
 *
 * Fetches a manifest from updates.agencybook.net once per check, compares to
 * current package.json version, returns structured update info.
 *
 * Manifest format (served as static JSON from updates.agencybook.net):
 *   {
 *     "channels": {
 *       "stable": {
 *         "version": "1.4.2",
 *         "released_at": "2026-05-01T12:00:00Z",
 *         "is_critical": false,
 *         "release_notes_url": "https://docs.agencybook.net/changelog#1-4-2",
 *         "minimum_version_to_update_from": "1.0.0",
 *         "estimated_downtime_seconds": 5
 *       },
 *       "beta": { ... },
 *       "lts":  { ... }
 *     }
 *   }
 *
 * Cache: 1 hour TTL — manifest fetch is cheap but don't hammer the static host.
 */

const fs = require('fs');
const path = require('path');
const licensing = require('./licensing');

const UPDATE_SERVER =
  process.env.UPDATE_SERVER_URL || 'https://updates.agencybook.net/v1/manifest.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache = { t: 0, manifest: null };

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function semverCompare(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchManifest() {
  const now = Date.now();
  if (cache.manifest && now - cache.t < CACHE_TTL_MS) return cache.manifest;

  try {
    const res = await fetch(UPDATE_SERVER, {
      headers: { 'X-Instance-Id': licensing.INSTANCE_ID },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    cache = { t: now, manifest };
    return manifest;
  } catch (err) {
    console.warn('[updateClient] manifest fetch failed:', err.message);
    return cache.manifest || null;
  }
}

async function checkForUpdate() {
  const currentVersion = getCurrentVersion();
  const channel = await licensing.getUpdateChannel();
  const manifest = await fetchManifest();

  if (!manifest || !manifest.channels?.[channel]) {
    return {
      current_version: currentVersion,
      channel,
      manifest_available: false,
      message: 'Update server unreachable — try again later.',
    };
  }

  const release = manifest.channels[channel];
  const cmp = semverCompare(release.version, currentVersion);

  return {
    current_version: currentVersion,
    channel,
    manifest_available: true,
    update_available: cmp > 0,
    is_critical: !!release.is_critical,
    latest_version: release.version,
    released_at: release.released_at || null,
    release_notes_url: release.release_notes_url || null,
    minimum_version_to_update_from: release.minimum_version_to_update_from || null,
    estimated_downtime_seconds: release.estimated_downtime_seconds || null,
    can_update: cmp > 0 && (
      !release.minimum_version_to_update_from ||
      semverCompare(currentVersion, release.minimum_version_to_update_from) >= 0
    ),
  };
}

function invalidate() { cache = { t: 0, manifest: null }; }

module.exports = { checkForUpdate, getCurrentVersion, invalidate };
