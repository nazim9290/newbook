/**
 * help-bot.js — Per-agency knowledge-base chatbot.
 *
 * Bot answers ONLY from the `bot_knowledge` table for the user's agency —
 * no LLM call, no hallucination. Matching is trigram + ILIKE so typos and
 * synonyms still hit. Each ask is logged in `bot_conversations` so admins
 * can spot gaps in the knowledge base.
 *
 * Endpoints:
 *   POST   /api/help-bot/ask              — any logged-in user; returns top match (+ alternatives)
 *   GET    /api/help-bot                  — admin: list this agency's entries
 *   POST   /api/help-bot                  — admin: add an entry
 *   PATCH  /api/help-bot/:id              — admin: update
 *   DELETE /api/help-bot/:id              — admin: delete
 *   GET    /api/help-bot/conversations    — admin: recent asks (last 100, w/ flag for unmatched)
 *   GET    /api/help-bot/categories       — any: distinct categories used by this agency
 */

const express = require('express');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(auth);
router.use(tenancy);

const SIM_THRESHOLD = 0.25;       // below this, treat as "no match"
const TOP_N = 3;                  // alternatives shown to user

function isAdmin(req) {
  const role = req.user?.role;
  return role === 'owner' || role === 'admin' || role === 'super_admin';
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}

// ── ASK (any logged-in user) ─────────────────────────────────────────
router.post('/ask', asyncHandler(async (req, res) => {
  const { question, page_context } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন লিখুন' });
  }
  const q = question.trim().slice(0, 500);

  // Trigram similarity on question + keyword overlap. Score = greatest of:
  //   - similarity(question, $q)            (typo-tolerant phrasing match)
  //   - 0.9 if any keyword ILIKE %$q%       (curated synonym hit, very high confidence)
  // Filter is_active and tenant scope. Top N by score.
  const sql = `
    SELECT id, question, answer, category, keywords,
           GREATEST(
             similarity(question, $1),
             CASE WHEN EXISTS (
               SELECT 1 FROM unnest(keywords) k
               WHERE $1 ILIKE '%' || k || '%' OR k ILIKE '%' || $1 || '%'
             ) THEN 0.9 ELSE 0 END,
             CASE WHEN question ILIKE '%' || $1 || '%' THEN 0.85 ELSE 0 END
           ) AS score
      FROM bot_knowledge
     WHERE agency_id = $2 AND is_active = TRUE
     ORDER BY score DESC
     LIMIT $3
  `;
  let rows = [];
  try {
    const r = await supabase.pool.query(sql, [q, req.user.agency_id, TOP_N]);
    rows = r.rows.filter(x => x.score >= SIM_THRESHOLD);
  } catch (err) {
    console.error('[help-bot] ask query failed:', err.message);
    return res.status(500).json({ error: 'বট সাময়িকভাবে অনুপলব্ধ' });
  }

  const top = rows[0] || null;
  const alternatives = rows.slice(1).map(r => ({
    id: r.id, question: r.question, score: Number(r.score.toFixed(2)),
  }));

  // Log conversation (fire-and-forget; don't block response)
  supabase.pool.query(
    `INSERT INTO bot_conversations (agency_id, user_id, question, matched_id, matched_score, page_context)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user.agency_id, req.user.id, q, top ? top.id : null, top ? top.score : null,
     (page_context || '').slice(0, 200)]
  ).then(() => {
    if (top) {
      // increment hits
      supabase.pool.query('UPDATE bot_knowledge SET hits = hits + 1 WHERE id = $1', [top.id])
        .catch(() => {});
    }
  }).catch(() => {});

  if (!top) {
    return res.json({
      matched: false,
      message: 'এই প্রশ্নের উত্তর এখনো শেখানো হয়নি। আপনার admin-কে জানান।',
      alternatives: [],
    });
  }

  res.json({
    matched: true,
    answer: top.answer,
    question: top.question,
    category: top.category,
    score: Number(top.score.toFixed(2)),
    alternatives,
  });
}));

// ── CATEGORIES (any user) ────────────────────────────────────────────
router.get('/categories', asyncHandler(async (req, res) => {
  const r = await supabase.pool.query(
    `SELECT DISTINCT category FROM bot_knowledge
      WHERE agency_id = $1 AND is_active = TRUE AND category IS NOT NULL AND category <> ''
      ORDER BY category`,
    [req.user.agency_id]
  );
  res.json(r.rows.map(x => x.category));
}));

// ── ADMIN: list ──────────────────────────────────────────────────────
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('bot_knowledge')
    .select('id, question, answer, keywords, category, is_active, hits, created_at, updated_at')
    .eq('agency_id', req.user.agency_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'লোড ব্যর্থ' });
  res.json(data || []);
}));

// ── ADMIN: create ────────────────────────────────────────────────────
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { question, answer, keywords = [], category = null, is_active = true } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'প্রশ্ন লিখুন' });
  if (!answer || !answer.trim()) return res.status(400).json({ error: 'উত্তর লিখুন' });

  const cleanKeywords = Array.isArray(keywords)
    ? keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 30)
    : [];

  const { data, error } = await supabase.from('bot_knowledge').insert({
    agency_id: req.user.agency_id,
    question: question.trim().slice(0, 500),
    answer: answer.trim().slice(0, 5000),
    keywords: cleanKeywords,
    category: category ? String(category).trim().slice(0, 50) : null,
    is_active: !!is_active,
    created_by: req.user.id,
  }).select().single();

  if (error) return res.status(500).json({ error: 'তৈরি ব্যর্থ' });

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'create',
    module: 'help-bot', recordId: data.id,
    description: `নতুন bot Q&A: ${data.question.slice(0, 60)}`, ip: req.ip,
  }).catch(() => {});

  res.json(data);
}));

// ── ADMIN: update ────────────────────────────────────────────────────
const PATCHABLE = ['question', 'answer', 'keywords', 'category', 'is_active'];

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const updates = {};
  for (const k of PATCHABLE) {
    if (req.body[k] === undefined) continue;
    if (k === 'keywords') {
      updates.keywords = Array.isArray(req.body.keywords)
        ? req.body.keywords.map(s => String(s).trim()).filter(Boolean).slice(0, 30)
        : [];
    } else if (k === 'is_active') {
      updates.is_active = !!req.body.is_active;
    } else if (k === 'question' || k === 'answer') {
      const v = String(req.body[k] || '').trim();
      if (!v) return res.status(400).json({ error: `${k === 'question' ? 'প্রশ্ন' : 'উত্তর'} খালি দেওয়া যাবে না` });
      updates[k] = v.slice(0, k === 'answer' ? 5000 : 500);
    } else if (k === 'category') {
      updates.category = req.body.category ? String(req.body.category).trim().slice(0, 50) : null;
    }
  }
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('bot_knowledge')
    .update(updates)
    .eq('id', req.params.id)
    .eq('agency_id', req.user.agency_id)
    .select().single();
  if (error) return res.status(500).json({ error: 'Update ব্যর্থ' });
  if (!data) return res.status(404).json({ error: 'এন্ট্রি পাওয়া যায়নি' });

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'update',
    module: 'help-bot', recordId: data.id,
    description: `Bot Q&A update: ${data.question.slice(0, 60)}`, ip: req.ip,
  }).catch(() => {});

  res.json(data);
}));

// ── ADMIN: delete ────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { data: existing } = await supabase.from('bot_knowledge')
    .select('id, question, agency_id').eq('id', req.params.id).single();
  if (!existing || existing.agency_id !== req.user.agency_id) {
    return res.status(404).json({ error: 'এন্ট্রি পাওয়া যায়নি' });
  }

  const { error } = await supabase.from('bot_knowledge')
    .delete().eq('id', req.params.id).eq('agency_id', req.user.agency_id);
  if (error) return res.status(500).json({ error: 'Delete ব্যর্থ' });

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: 'delete',
    module: 'help-bot', recordId: req.params.id,
    description: `Bot Q&A delete: ${existing.question.slice(0, 60)}`, ip: req.ip,
  }).catch(() => {});

  res.json({ ok: true });
}));

// ── ADMIN: conversation log ──────────────────────────────────────────
router.get('/conversations', requireAdmin, asyncHandler(async (req, res) => {
  const onlyUnmatched = req.query.unmatched === '1';
  const sql = `
    SELECT c.id, c.question, c.matched_id, c.matched_score, c.page_context, c.created_at,
           u.name AS user_name, k.question AS matched_question
      FROM bot_conversations c
      LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN bot_knowledge k ON k.id = c.matched_id
     WHERE c.agency_id = $1
       ${onlyUnmatched ? 'AND c.matched_id IS NULL' : ''}
     ORDER BY c.created_at DESC
     LIMIT 100
  `;
  const r = await supabase.pool.query(sql, [req.user.agency_id]);
  res.json(r.rows);
}));

module.exports = router;
