/**
 * outbound-webhooks.js — Phase 13: customer-registered URLs we POST events to.
 *
 * Distinct from the existing inbound webhooks (`routes/webhooks.js` — events
 * we receive from third parties). Outbound webhooks let customers integrate
 * AgencyBook events with their own systems.
 *
 * Endpoints (owner/admin only):
 *   GET    /api/outbound-webhooks               — list this agency's subscribers
 *   POST   /api/outbound-webhooks               — register a new URL
 *   PATCH  /api/outbound-webhooks/:id           — update events / toggle active
 *   DELETE /api/outbound-webhooks/:id           — remove
 *   GET    /api/outbound-webhooks/:id/deliveries — recent delivery attempts log
 *   POST   /api/outbound-webhooks/:id/test      — fire a synthetic 'webhook.test' event
 *
 * Storage: webhook_endpoints + webhook_deliveries (Phase 13 migration).
 * Delivery logic: lib/webhooks.js fire().
 */

const express = require('express');
const crypto = require('crypto');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { logActivity } = require('../lib/activityLog');
const { fire, KNOWN_EVENTS } = require('../lib/webhooks');

const router = express.Router();
router.use(auth);
router.use(tenancy);

function requireAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === 'owner' || role === 'admin' || role === 'super_admin') return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}
router.use(requireAdmin);

// ── List ──────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('webhook_endpoints')
    .select('id, url, events, is_active, failure_count, last_success_at, last_failure_at, created_at')
    .eq('agency_id', req.user.agency_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'লোড ব্যর্থ' });
  res.json(data || []);
}));

// ── Available event types ────────────────────────────────────────────
router.get('/events', asyncHandler(async (req, res) => {
  res.json(KNOWN_EVENTS);
}));

// ── Create ────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const { url, events } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'বৈধ http(s):// URL দিন' });
  }
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'অন্তত একটা event subscribe করুন' });
  }
  for (const e of events) {
    if (e !== '*' && !KNOWN_EVENTS.includes(e)) {
      return res.status(400).json({ error: `Unknown event: ${e}` });
    }
  }

  // Server-generated HMAC secret — returned ONCE
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;

  const { data, error } = await supabase.from('webhook_endpoints').insert({
    agency_id: req.user.agency_id,
    url, events, secret,
    is_active: true,
    created_by: req.user.id,
  }).select().single();

  if (error) {
    console.error('[outbound-webhooks] insert failed:', error.message);
    return res.status(500).json({ error: 'তৈরি ব্যর্থ' });
  }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'create',
    module: 'outbound-webhooks', recordId: data.id,
    description: `Webhook subscriber added: ${url}`, ip: req.ip,
  }).catch(() => {});

  // Show secret ONCE
  res.json({
    id: data.id,
    url: data.url,
    events: data.events,
    is_active: data.is_active,
    created_at: data.created_at,
    secret,
    _warning: 'এই secret আর কখনো দেখানো হবে না — এখনই save করুন',
  });
}));

// ── Update (toggle active / change events) ────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const { events, is_active } = req.body || {};
  const updates = {};
  if (Array.isArray(events)) {
    for (const e of events) {
      if (e !== '*' && !KNOWN_EVENTS.includes(e)) {
        return res.status(400).json({ error: `Unknown event: ${e}` });
      }
    }
    updates.events = events;
  }
  if (typeof is_active === 'boolean') {
    updates.is_active = is_active;
    if (is_active) updates.failure_count = 0; // reset on manual reactivation
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('webhook_endpoints')
    .update(updates)
    .eq('id', req.params.id)
    .eq('agency_id', req.user.agency_id)
    .select().single();
  if (error) return res.status(500).json({ error: 'Update ব্যর্থ' });
  if (!data) return res.status(404).json({ error: 'Webhook পাওয়া যায়নি' });
  res.json(data);
}));

// ── Delete ────────────────────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const { error } = await supabase.from('webhook_endpoints')
    .delete()
    .eq('id', req.params.id)
    .eq('agency_id', req.user.agency_id);
  if (error) return res.status(500).json({ error: 'Delete ব্যর্থ' });
  res.json({ ok: true });
}));

// ── Deliveries log (last 50) ──────────────────────────────────────────
router.get('/:id/deliveries', asyncHandler(async (req, res) => {
  // Verify ownership
  const { data: ep } = await supabase.from('webhook_endpoints')
    .select('id, agency_id').eq('id', req.params.id).single();
  if (!ep || ep.agency_id !== req.user.agency_id) {
    return res.status(404).json({ error: 'Webhook পাওয়া যায়নি' });
  }
  const { data } = await supabase.from('webhook_deliveries')
    .select('event, attempt, status_code, succeeded, delivered_at')
    .eq('webhook_id', req.params.id)
    .order('delivered_at', { ascending: false })
    .limit(50);
  res.json(data || []);
}));

// ── Test fire ─────────────────────────────────────────────────────────
router.post('/:id/test', asyncHandler(async (req, res) => {
  const { data: ep } = await supabase.from('webhook_endpoints')
    .select('id, agency_id').eq('id', req.params.id).single();
  if (!ep || ep.agency_id !== req.user.agency_id) {
    return res.status(404).json({ error: 'Webhook পাওয়া যায়নি' });
  }
  // Fire a synthetic event
  await fire(req.user.agency_id, 'student.created', {
    _test: true,
    student_id: 'test-' + Date.now(),
    name_en: 'Test Student',
    fired_by: req.user.email,
  });
  res.json({ ok: true, message: 'Test event fired — check deliveries log in 5-30 sec' });
}));

module.exports = router;
