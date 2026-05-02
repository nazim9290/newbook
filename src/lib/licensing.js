/**
 * licensing.js — License abstraction layer (Phase 0)
 *
 * Single source of truth for "what is this instance allowed to do?"
 * Three deployment modes, three drivers:
 *
 *   - 'shared-saas'   → reads from `licenses` table by INSTANCE_ID env
 *   - 'dedicated'     → same as shared-saas + (later) phones home to license server
 *   - 'on-premise'    → reads signed JWT from Redis (Phase 14, not yet implemented)
 *
 * License row drives:
 *   - max_agencies      (gates POST /super-admin/agencies)
 *   - features.*        (gates UI panels and feature endpoints)
 *   - update_channel    (Phase 2: which release channel to follow)
 *   - status            (active / past_due / suspended / cancelled)
 *
 * Backward-compat: if `licenses` table missing OR no row for INSTANCE_ID,
 * falls back to PERMISSIVE defaults (max_agencies: 999, all features on).
 * This keeps existing prod working until the migration + seed is applied.
 *
 * Cache: in-memory, 60s TTL. Call `invalidate()` after license change.
 */

const supabase = require('./db');

const INSTANCE_ID = process.env.INSTANCE_ID || 'demo';
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'shared-saas';

// Permissive fallback — used when license row not found.
// Mirrors the default seed for 'demo' so behaviour is identical pre/post migration.
const PERMISSIVE_FALLBACK = Object.freeze({
  instance_id: INSTANCE_ID,
  max_agencies: 999,
  features: Object.freeze({
    super_admin_panel: true,
    agency_switcher_ui: true,
    multi_branch: true,
    ai_translation: true,
    ai_ocr: true,
    smart_matching: true,
    central_proxy: false,
  }),
  update_channel: 'stable',
  status: 'active',
  expires_at: null,
  _fallback: true,
});

const CACHE_TTL_MS = 60 * 1000;
let cache = { t: 0, data: null };

async function fetchLicense() {
  try {
    const { data, error } = await supabase.from('licenses')
      .select('instance_id, max_agencies, features, update_channel, status, expires_at, license_key')
      .eq('instance_id', INSTANCE_ID)
      .order('issued_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // Table not yet migrated — fall back silently
      if (/relation .* does not exist|does not exist/i.test(error.message || '')) {
        return PERMISSIVE_FALLBACK;
      }
      console.warn('[licensing] DB error, using permissive fallback:', error.message);
      return PERMISSIVE_FALLBACK;
    }

    if (!data) {
      console.warn(`[licensing] No license row for instance '${INSTANCE_ID}' — using permissive fallback. Run seed-license.js to fix.`);
      return PERMISSIVE_FALLBACK;
    }

    return {
      ...data,
      features: data.features || {},
    };
  } catch (err) {
    console.error('[licensing] Unexpected error, using fallback:', err.message);
    return PERMISSIVE_FALLBACK;
  }
}

async function getCurrent() {
  const now = Date.now();
  if (cache.data && (now - cache.t) < CACHE_TTL_MS) return cache.data;
  const data = await fetchLicense();
  cache = { t: now, data };
  return data;
}

function invalidate() {
  cache = { t: 0, data: null };
}

async function getMaxAgencies() {
  return (await getCurrent()).max_agencies || 1;
}

async function getFeatures() {
  return (await getCurrent()).features || {};
}

async function hasFeature(name) {
  const features = await getFeatures();
  return features[name] === true;
}

async function getUpdateChannel() {
  return (await getCurrent()).update_channel || 'stable';
}

async function getStatus() {
  return (await getCurrent()).status || 'active';
}

/**
 * canAddAgency — checks both license status AND max_agencies count.
 * Returns { ok, reason?, message?, current?, max? }.
 */
async function canAddAgency() {
  const lic = await getCurrent();

  if (lic.status !== 'active' && lic.status !== 'past_due') {
    return {
      ok: false,
      reason: 'license_inactive',
      message: 'লাইসেন্স active নেই — agency তৈরি করা যাবে না।',
    };
  }

  const maxAgencies = lic.max_agencies || 1;

  // Count current agencies via raw pg pool (Supabase wrapper count is unreliable)
  let currentCount = 0;
  try {
    const pool = supabase.pool;
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM agencies');
    currentCount = rows[0]?.count || 0;
  } catch (err) {
    console.warn('[licensing] Could not count agencies:', err.message);
    return { ok: true, current: 0, max: maxAgencies, _warning: 'count_failed' };
  }

  if (currentCount >= maxAgencies) {
    return {
      ok: false,
      reason: 'max_agencies_reached',
      current: currentCount,
      max: maxAgencies,
      message: `এই license-এ সর্বোচ্চ ${maxAgencies}টি agency permitted, বর্তমানে ${currentCount}টি আছে। Multi-tenant upgrade-এর জন্য support team-এ যোগাযোগ করুন।`,
    };
  }

  return { ok: true, current: currentCount, max: maxAgencies };
}

/**
 * checkBootIntegrity — at startup, verifies agencies count <= max_agencies.
 * If violated, returns { ok: false, ... } so caller can decide to log/alert/exit.
 */
async function checkBootIntegrity() {
  const lic = await getCurrent();
  const maxAgencies = lic.max_agencies || 1;

  let currentCount = 0;
  try {
    const pool = supabase.pool;
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM agencies');
    currentCount = rows[0]?.count || 0;
  } catch (err) {
    return { ok: true, _skipped: true, reason: 'count_failed', error: err.message };
  }

  if (currentCount > maxAgencies) {
    return {
      ok: false,
      currentCount,
      maxAgencies,
      message: `License violation: ${currentCount} agencies present, license permits only ${maxAgencies}`,
    };
  }

  return { ok: true, currentCount, maxAgencies, fallback: !!lic._fallback };
}

/**
 * getPublicInfo — sanitized license payload for /api/system/license.
 * No license_key, no signature. Safe to expose to authenticated frontend.
 */
async function getPublicInfo() {
  const lic = await getCurrent();
  return {
    instance_id: lic.instance_id,
    deployment_mode: DEPLOYMENT_MODE,
    max_agencies: lic.max_agencies || 1,
    features: lic.features || {},
    update_channel: lic.update_channel || 'stable',
    status: lic.status || 'active',
    expires_at: lic.expires_at || null,
    is_multi_tenant: (lic.max_agencies || 1) > 1,
    _fallback: !!lic._fallback,
  };
}

module.exports = {
  INSTANCE_ID,
  DEPLOYMENT_MODE,
  getCurrent,
  invalidate,
  getMaxAgencies,
  getFeatures,
  hasFeature,
  getUpdateChannel,
  getStatus,
  canAddAgency,
  checkBootIntegrity,
  getPublicInfo,
};
