/**
 * apiKeyAuth.js — Phase 13: API key authentication for public API.
 *
 * Headers accepted:
 *   Authorization: Bearer agbk_live_xxxxxxxxxxxxxxxxxxxxxxxxxx
 *   X-API-Key:     agbk_live_xxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Sets req.apiKey { id, agency_id, scopes, rate_limit_rpm } on success.
 * Use BOTH this AND a separate require-scope middleware:
 *
 *   router.use(apiKeyAuth);
 *   router.use(requireScope('write'));
 *
 * Rate limiting is applied per-key via in-memory token bucket (no Redis needed
 * for MVP; replace with Redis when scale demands).
 */

const bcrypt = require('bcryptjs');
const supabase = require('../lib/db');

const RATE_BUCKETS = new Map();

function checkRateLimit(keyId, rpm) {
  const now = Date.now();
  let bucket = RATE_BUCKETS.get(keyId);
  if (!bucket) {
    bucket = { tokens: rpm, refilled_at: now, capacity: rpm };
    RATE_BUCKETS.set(keyId, bucket);
  }
  // Refill: rpm tokens per minute → tokens/ms
  const elapsedMs = now - bucket.refilled_at;
  const refill = (rpm / 60000) * elapsedMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill);
  bucket.refilled_at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

async function apiKeyAuth(req, res, next) {
  const headerKey = (req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();

  if (!headerKey || !headerKey.startsWith('agbk_')) {
    return res.status(401).json({ error: 'API key required (Authorization: Bearer agbk_live_...)' });
  }

  const prefix = headerKey.slice(0, 16);

  // Look up by prefix (indexed), validate hash matches
  const { data: candidates } = await supabase.from('api_keys')
    .select('id, agency_id, key_hash, scopes, rate_limit_rpm, revoked_at, expires_at')
    .eq('prefix', prefix);

  if (!candidates || candidates.length === 0) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  let matched = null;
  for (const c of candidates) {
    if (c.revoked_at) continue;
    if (c.expires_at && new Date(c.expires_at) < new Date()) continue;
    if (await bcrypt.compare(headerKey, c.key_hash)) { matched = c; break; }
  }

  if (!matched) return res.status(401).json({ error: 'Invalid API key' });

  // Rate limit
  if (!checkRateLimit(matched.id, matched.rate_limit_rpm || 60)) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      limit_rpm: matched.rate_limit_rpm,
    });
  }

  // Async last-used tracking — don't block request
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() })
    .eq('id', matched.id).then(() => {}).catch(() => {});

  req.apiKey = {
    id: matched.id,
    agency_id: matched.agency_id,
    scopes: matched.scopes || ['read'],
    rate_limit_rpm: matched.rate_limit_rpm,
  };
  // Mirror agency_id onto req for downstream tenancy enforcement
  req.user = { ...(req.user || {}), id: matched.id, agency_id: matched.agency_id, role: 'api_client' };
  next();
}

function requireScope(needed) {
  return (req, res, next) => {
    const scopes = req.apiKey?.scopes || [];
    if (!scopes.includes(needed) && !scopes.includes('admin')) {
      return res.status(403).json({ error: `Scope required: ${needed}` });
    }
    next();
  };
}

module.exports = { apiKeyAuth, requireScope };
