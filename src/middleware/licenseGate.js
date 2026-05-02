/**
 * licenseGate.js — License enforcement middleware (Phase 0)
 *
 * Two exports:
 *
 *   multiTenantGuard()
 *     — Mount BEFORE routes that create new agencies (e.g., POST /super-admin/agencies)
 *     — Returns 402 if max_agencies reached or license inactive
 *
 *   bootIntegrityCheck({ strict })
 *     — Run once at server startup
 *     — Logs warning (or exits if strict) when DB has more agencies than license permits
 *     — Use strict mode in customer-vps + on-premise deployments
 *
 *   featureGate(featureName)
 *     — Generic gate: 403 if license.features[featureName] !== true
 *     — Use to lock feature endpoints (e.g., /api/docgen, /api/ocr) by feature flag
 */

const licensing = require('../lib/licensing');

function multiTenantGuard() {
  return async function (req, res, next) {
    try {
      const result = await licensing.canAddAgency();
      if (!result.ok) {
        return res.status(402).json({
          error: result.message || 'এই license multi-tenant permission দেয় না।',
          code: 'MULTI_TENANT_NOT_LICENSED',
          reason: result.reason,
          current: result.current,
          max: result.max,
        });
      }
      next();
    } catch (err) {
      console.error('[licenseGate] multiTenantGuard error:', err.message);
      // On unexpected error: fail-open in shared-saas (don't break demo),
      // operator can tighten by switching to strict mode later.
      next();
    }
  };
}

function featureGate(featureName) {
  return async function (req, res, next) {
    try {
      const enabled = await licensing.hasFeature(featureName);
      if (!enabled) {
        return res.status(403).json({
          error: `এই feature (${featureName}) আপনার license-এ চালু নেই।`,
          code: 'FEATURE_NOT_LICENSED',
          feature: featureName,
        });
      }
      next();
    } catch (err) {
      console.error(`[licenseGate] featureGate(${featureName}) error:`, err.message);
      next(); // fail-open
    }
  };
}

async function bootIntegrityCheck({ strict = false } = {}) {
  try {
    const result = await licensing.checkBootIntegrity();

    if (result._skipped) {
      console.log(`[licensing] Boot integrity check skipped (${result.reason})`);
      return;
    }

    if (!result.ok) {
      const banner = '═══════════════════════════════════════════════════════════';
      console.error(banner);
      console.error('[BOOT FATAL] License violation detected');
      console.error(`  Instance:        ${licensing.INSTANCE_ID}`);
      console.error(`  Deployment mode: ${licensing.DEPLOYMENT_MODE}`);
      console.error(`  Agencies in DB:  ${result.currentCount}`);
      console.error(`  License permits: ${result.maxAgencies}`);
      console.error('  Action required: contact license issuer to upgrade,');
      console.error('                   or remove excess agencies.');
      console.error(banner);

      if (strict) {
        console.error('[BOOT] strict=true → exiting process');
        process.exit(1);
      }
      console.warn('[BOOT] strict=false → continuing (license violation logged)');
      return;
    }

    const fallbackNote = result.fallback ? ' (permissive fallback — run seed-license.js)' : '';
    console.log(
      `[licensing] Boot OK — ${result.currentCount}/${result.maxAgencies} agencies for instance '${licensing.INSTANCE_ID}'${fallbackNote}`
    );
  } catch (err) {
    console.error('[licensing] Boot integrity check failed:', err.message);
    // Don't crash on transient error
  }
}

module.exports = { multiTenantGuard, featureGate, bootIntegrityCheck };
