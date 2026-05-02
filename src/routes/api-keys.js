/**
 * api-keys.js — Phase 13: admin endpoints to manage public API keys.
 *
 * Auth: JWT (owner / admin / super_admin only — staff can't generate keys).
 *
 * Endpoints:
 *   GET    /api/api-keys           — list this agency's keys (full key never returned)
 *   POST   /api/api-keys           — create new key. Returns the FULL key ONCE.
 *   DELETE /api/api-keys/:id       — revoke a key
 *
 * Key format: agbk_<env>_<32-char>
 *   env = 'live' (prod) | 'test' (sandbox; not enforced yet)
 *
 * Storage: prefix (first 16 chars) stored unhashed for index lookup;
 * full key only returned on create. Hash is bcrypt for offline brute-force
 * resistance.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(auth);
router.use(tenancy);

function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === 'owner' || role === 'admin' || role === 'super_admin') return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}
router.use(requireAdmin);

const VALID_SCOPES = ['read', 'write', 'admin'];

router.get('/', asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('api_keys')
    .select('id, name, prefix, scopes, rate_limit_rpm, last_used_at, expires_at, revoked_at, created_at')
    .eq('agency_id', req.user.agency_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'লোড ব্যর্থ' });
  res.json(data || []);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, scopes = ['read'], rate_limit_rpm = 60, expires_in_days } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'নাম দিন' });
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: 'অন্তত একটা scope দিন' });
  }
  for (const s of scopes) {
    if (!VALID_SCOPES.includes(s)) {
      return res.status(400).json({ error: `Invalid scope: ${s}` });
    }
  }
  const rpm = Math.max(10, Math.min(1000, parseInt(rate_limit_rpm, 10) || 60));

  // Generate raw key
  const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
  const random = crypto.randomBytes(20).toString('base64url').slice(0, 32);
  const fullKey = `agbk_${env}_${random}`;
  const prefix = fullKey.slice(0, 16);
  const hash = await bcrypt.hash(fullKey, 10);

  let expiresAt = null;
  if (expires_in_days) {
    expiresAt = new Date(Date.now() + parseInt(expires_in_days, 10) * 86400000).toISOString();
  }

  const { data, error } = await supabase.from('api_keys').insert({
    agency_id: req.user.agency_id,
    name: name.trim(),
    prefix,
    key_hash: hash,
    scopes,
    rate_limit_rpm: rpm,
    expires_at: expiresAt,
    created_by: req.user.id,
  }).select().single();

  if (error) {
    console.error('[api-keys] insert failed:', error.message);
    return res.status(500).json({ error: 'API key তৈরি ব্যর্থ' });
  }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'create',
    module: 'api-keys', recordId: data.id,
    description: `নতুন API key: ${name.trim()}`, ip: req.ip,
  }).catch(() => {});

  // CRITICAL: return full key ONCE — UI must show it now and never again
  res.json({
    id: data.id,
    name: data.name,
    prefix: data.prefix,
    scopes: data.scopes,
    rate_limit_rpm: data.rate_limit_rpm,
    expires_at: data.expires_at,
    created_at: data.created_at,
    full_key: fullKey,
    _warning: 'এই key আর কখনো দেখানো হবে না — এখনই save করুন',
  });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { data: existing } = await supabase.from('api_keys')
    .select('id, name, agency_id, revoked_at').eq('id', req.params.id).single();
  if (!existing) return res.status(404).json({ error: 'API key পাওয়া যায়নি' });
  if (existing.agency_id !== req.user.agency_id) {
    return res.status(403).json({ error: 'অন্য agency-র key revoke করা যাবে না' });
  }
  if (existing.revoked_at) {
    return res.status(400).json({ error: 'ইতিমধ্যে revoked' });
  }

  const { error } = await supabase.from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Revoke ব্যর্থ' });

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'delete',
    module: 'api-keys', recordId: req.params.id,
    description: `API key revoked: ${existing.name}`, ip: req.ip,
  }).catch(() => {});

  res.json({ ok: true });
}));

module.exports = router;
