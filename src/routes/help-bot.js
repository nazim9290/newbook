/**
 * help-bot.js — Per-agency knowledge-base chatbot (Hybrid v2).
 *
 * Pipeline for /ask:
 *   1. Match against bot_knowledge — trigram + keyword + ILIKE.
 *      Filters: agency_id (always), is_active, min_role (>= user's role).
 *   2. If top match has query_type → run permission-checked SQL via
 *      botQueryRegistry → render template with results → return.
 *   3. Else if top match score >= HIGH_THRESHOLD (and permission OK) → return KB answer as-is.
 *   4. Else if agency.bot_llm_enabled → call Claude with KB top-N + safe context.
 *   5. Else return "no answer learned yet" message.
 *
 * Three guardrails enforced at every layer:
 *   • Tenant   — every query .eq('agency_id', req.user.agency_id)
 *   • Role     — min_role gate; LLM system prompt locks scope to user's role
 *   • Permission — query_type fires only if user has the required perm;
 *                  same goes for static KB entries with permission_required
 */

const express = require('express');
const supabase = require('../lib/db');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const asyncHandler = require('../lib/asyncHandler');
const { logActivity } = require('../lib/activityLog');
const { DEFAULT_PERMISSIONS, normalizeRole } = require('../middleware/checkPermission');
const { runQuery } = require('../lib/botQueryRegistry');
const { askLlm } = require('../lib/botLlm');

const router = express.Router();
router.use(auth);
router.use(tenancy);

const SIM_THRESHOLD = 0.25;        // below: definitely no match
const HIGH_THRESHOLD = 0.6;        // above: high-confidence KB answer
const TOP_N = 3;                   // KB matches surfaced to user / fed to LLM

// Role hierarchy for min_role filter.
// A user with role X can see entries with min_role <= X.
const ROLE_RANK = {
  staff: 1,
  counselor: 1, "follow-up_executive": 1, admission_officer: 1, language_teacher: 1,
  document_collector: 1, document_processor: 1, accounts: 1,
  branch_manager: 2,
  admin: 3,
  owner: 4,
  super_admin: 5,
};
function userRank(role) {
  return ROLE_RANK[normalizeRole(role)] || 1;
}
function minRoleAllowsUser(minRole, userRole) {
  if (!minRole) return true;
  return userRank(userRole) >= (ROLE_RANK[normalizeRole(minRole)] || 99);
}

function userHasPermissionFn(user) {
  return (permKey) => {
    if (!permKey) return true;
    const role = normalizeRole(user.role);
    if (role === "super_admin" || role === "owner") return true;
    const [mod, action] = String(permKey).split(":");
    const perms = DEFAULT_PERMISSIONS[role];
    if (!perms || !perms[mod]) return false;
    const ch = action === "read" ? "r" : action === "write" ? "w" : action === "delete" ? "d" : "";
    return perms[mod].includes(ch);
  };
}

function isAdmin(req) {
  const role = normalizeRole(req.user?.role);
  return role === 'owner' || role === 'admin' || role === 'super_admin';
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).json({ error: 'এই page শুধু owner/admin-এর জন্য' });
}

// ── Fetch the agency's LLM toggle + agency name (for system prompt) ──
async function loadAgencyContext(agencyId) {
  // settings (LLM toggle)
  let llmEnabled = false;
  try {
    const r = await supabase.pool.query(
      "SELECT bot_llm_enabled FROM agency_settings WHERE agency_id = $1 LIMIT 1",
      [agencyId]
    );
    llmEnabled = !!r.rows[0]?.bot_llm_enabled;
  } catch { /* settings table optional */ }

  // agency name for prompt
  let agencyName = "your agency";
  try {
    const r = await supabase.pool.query(
      "SELECT name, name_bn FROM agencies WHERE id = $1 LIMIT 1",
      [agencyId]
    );
    agencyName = r.rows[0]?.name_bn || r.rows[0]?.name || agencyName;
  } catch { /* ignore */ }

  return { llmEnabled, agencyName };
}

// ════════════════════════════════════════════════════════════════════════
// POST /ask — any logged-in user
// ════════════════════════════════════════════════════════════════════════
router.post('/ask', asyncHandler(async (req, res) => {
  const { question, page_context } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন লিখুন' });
  }
  const q = question.trim().slice(0, 500);
  const hasPermission = userHasPermissionFn(req.user);

  // ── 1. KB lookup (top N candidates, role-gated, agency-scoped) ──
  // Three signals, take the strongest:
  //   a) trigram similarity on question text (handles typos/phrasing)
  //   b) keyword overlap — keywords MUST be ≥ 5 chars to be considered.
  //      Short keywords like "what"/"add"/"কী" matched too many unrelated
  //      questions via ILIKE substring. 5+ char threshold drops most
  //      generic English/Bengali stop-words while keeping domain terms
  //      ("student", "visitor", "agency", etc.).
  //   c) full-question phrase ILIKE — only fires when user input is ≥ 8
  //      chars (so "test" doesn't trigger a phrase match on every entry
  //      with "test" in it).
  // Pull TOP_N+4, then filter by min_role + permission in JS.
  const sql = `
    SELECT id, question, answer, category, keywords, min_role, query_type, permission_required,
           GREATEST(
             similarity(question, $1),
             CASE WHEN EXISTS (
               SELECT 1 FROM unnest(keywords) k
                WHERE char_length(k) >= 5
                  AND $1 ILIKE '%' || k || '%'
             ) THEN 0.9 ELSE 0 END,
             CASE WHEN char_length($1) >= 8 AND question ILIKE '%' || $1 || '%' THEN 0.85 ELSE 0 END
           ) AS score
      FROM bot_knowledge
     WHERE agency_id = $2 AND is_active = TRUE
     ORDER BY score DESC
     LIMIT $3
  `;
  let candidates = [];
  try {
    const r = await supabase.pool.query(sql, [q, req.user.agency_id, TOP_N + 4]);
    candidates = r.rows
      .filter(x => x.score >= SIM_THRESHOLD)
      .filter(x => minRoleAllowsUser(x.min_role, req.user.role))
      .filter(x => hasPermission(x.permission_required));
  } catch (err) {
    console.error('[help-bot] KB query failed:', err.message);
    return res.status(500).json({ error: 'বট সাময়িকভাবে অনুপলব্ধ' });
  }

  const top = candidates[0] || null;
  const alternatives = candidates.slice(1, TOP_N).map(r => ({
    id: r.id, question: r.question, score: Number(r.score.toFixed(2)),
  }));

  let answer = null;
  let source = 'kb';
  let matchedId = null;
  let matchedScore = null;
  let tokensIn = 0, tokensOut = 0;

  // ── 2. High-confidence KB hit with query_type → live data ──
  if (top && top.score >= HIGH_THRESHOLD && top.query_type) {
    const qr = await runQuery({
      key: top.query_type,
      agencyId: req.user.agency_id,
      answerTemplate: top.answer,
      hasPermission,
      pool: supabase.pool,
    });
    if (qr.ok) {
      answer = qr.text;
      source = 'kb+query';
      matchedId = top.id;
      matchedScore = top.score;
    } else if (qr.error === 'no_permission') {
      answer = "আপনার role-এ এই data দেখার access নেই — owner/admin-কে জিজ্ঞেস করুন।";
      source = 'refused';
    }
    // exec_failed / unknown_query → fall through to plain KB / LLM
  }

  // ── 3. High-confidence KB hit, plain answer ──
  if (!answer && top && top.score >= HIGH_THRESHOLD) {
    answer = top.answer;
    source = 'kb';
    matchedId = top.id;
    matchedScore = top.score;
  }

  // ── 4. LLM fallback (only if enabled + key configured) ──
  let llmTried = false;
  if (!answer) {
    const ctx = await loadAgencyContext(req.user.agency_id);
    if (ctx.llmEnabled) {
      llmTried = true;
      const llm = await askLlm({
        question: q,
        agencyId: req.user.agency_id,
        agencyName: ctx.agencyName,
        user: req.user,
        pageContext: page_context || '',
        kbMatches: candidates.slice(0, TOP_N),
        dataSummary: {},     // future: pre-compute small summaries here
        llmEnabled: true,
      });
      if (llm.ok) {
        answer = llm.text;
        source = 'llm';
        tokensIn = llm.tokensIn;
        tokensOut = llm.tokensOut;
      }
    }
  }

  // ── 5. Log conversation (fire-and-forget) ──
  supabase.pool.query(
    `INSERT INTO bot_conversations
       (agency_id, user_id, question, matched_id, matched_score, page_context, source, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [req.user.agency_id, req.user.id, q, matchedId, matchedScore,
     (page_context || '').slice(0, 200), answer ? source : 'unmatched', tokensIn, tokensOut]
  ).then(() => {
    if (matchedId) {
      supabase.pool.query('UPDATE bot_knowledge SET hits = hits + 1 WHERE id = $1', [matchedId])
        .catch(() => {});
    }
  }).catch(() => {});

  // ── 6. Respond ──
  if (!answer) {
    return res.json({
      matched: false,
      source: llmTried ? 'llm_failed' : 'no_match',
      message: 'এই প্রশ্নের উত্তর এখনো শেখানো হয়নি। আপনার admin-কে জানান — তিনি bot-কে শেখাতে পারেন।',
      alternatives,
    });
  }

  res.json({
    matched: true,
    source,                             // 'kb' | 'kb+query' | 'llm' | 'refused'
    answer,
    question: top?.question || null,
    category: top?.category || null,
    score: matchedScore != null ? Number(matchedScore.toFixed(2)) : null,
    alternatives,
  });
}));

// ════════════════════════════════════════════════════════════════════════
// GET /categories — any user
// ════════════════════════════════════════════════════════════════════════
router.get('/categories', asyncHandler(async (req, res) => {
  const r = await supabase.pool.query(
    `SELECT DISTINCT category FROM bot_knowledge
      WHERE agency_id = $1 AND is_active = TRUE AND category IS NOT NULL AND category <> ''
      ORDER BY category`,
    [req.user.agency_id]
  );
  res.json(r.rows.map(x => x.category));
}));

// ════════════════════════════════════════════════════════════════════════
// GET /query-types — admin: list available query templates (for form dropdown)
// ════════════════════════════════════════════════════════════════════════
router.get('/query-types', requireAdmin, asyncHandler(async (req, res) => {
  const { REGISTRY } = require('../lib/botQueryRegistry');
  res.json(Object.entries(REGISTRY).map(([k, v]) => ({
    key: k,
    permission: v.permission,
  })));
}));

// ════════════════════════════════════════════════════════════════════════
// ADMIN CRUD
// ════════════════════════════════════════════════════════════════════════
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('bot_knowledge')
    .select('id, question, answer, keywords, category, min_role, query_type, permission_required, is_active, is_seed, hits, created_at, updated_at')
    .eq('agency_id', req.user.agency_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'লোড ব্যর্থ' });
  res.json(data || []);
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { question, answer, keywords = [], category = null, is_active = true,
          min_role = null, query_type = null, permission_required = null } = req.body || {};
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
    min_role: min_role || null,
    query_type: query_type || null,
    permission_required: permission_required || null,
    is_active: !!is_active,
    is_seed: false,
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

const PATCHABLE = ['question', 'answer', 'keywords', 'category', 'is_active',
                   'min_role', 'query_type', 'permission_required'];

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
    } else {
      // min_role / query_type / permission_required — string or null
      updates[k] = req.body[k] || null;
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

// ════════════════════════════════════════════════════════════════════════
// GET /conversations — admin
//   ?unmatched=1            only ones that didn't match
//   ?low_score=1            matched but score < 0.6 (improvable)
//   ?range=7d|30d|all       time window (default 30d)
//   ?source=kb|kb+query|llm|no_match|refused
//   ?search=                ILIKE on question text
//   ?page=1&pageSize=50     pagination (default 50, max 200)
// Returns { items, total, page, pageSize }
// ════════════════════════════════════════════════════════════════════════
function rangeToInterval(range) {
  if (range === 'all') return null;
  if (range === '7d') return '7 days';
  if (range === '24h') return '1 day';
  return '30 days';
}

router.get('/conversations', requireAdmin, asyncHandler(async (req, res) => {
  const filters = ['c.agency_id = $1'];
  const params = [req.user.agency_id];
  let pi = 2;

  if (req.query.unmatched === '1') filters.push('c.matched_id IS NULL');
  if (req.query.low_score === '1') filters.push('c.matched_id IS NOT NULL AND c.matched_score < 0.6');

  const interval = rangeToInterval(req.query.range);
  if (interval) {
    filters.push(`c.created_at >= now() - interval '${interval}'`);
  }
  if (req.query.source) {
    filters.push(`c.source = $${pi++}`);
    params.push(req.query.source);
  }
  if (req.query.search && req.query.search.trim()) {
    filters.push(`c.question ILIKE $${pi++}`);
    params.push('%' + req.query.search.trim() + '%');
  }

  const where = 'WHERE ' + filters.join(' AND ');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
  const offset = (page - 1) * pageSize;

  const totalRes = await supabase.pool.query(
    `SELECT count(*)::int AS n FROM bot_conversations c ${where}`,
    params
  );
  const total = totalRes.rows[0]?.n ?? 0;

  const itemsRes = await supabase.pool.query(`
    SELECT c.id, c.question, c.matched_id, c.matched_score, c.page_context,
           c.source, c.tokens_in, c.tokens_out, c.created_at,
           u.name AS user_name, k.question AS matched_question
      FROM bot_conversations c
      LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN bot_knowledge k ON k.id = c.matched_id
      ${where}
     ORDER BY c.created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}
  `, params);

  res.json({ items: itemsRes.rows, total, page, pageSize });
}));

// ════════════════════════════════════════════════════════════════════════
// GET /conversations/clusters — group by normalized question text
// Same filters as /conversations but aggregates instead of paginates.
// Returns top 100 clusters sorted by frequency.
// ════════════════════════════════════════════════════════════════════════
router.get('/conversations/clusters', requireAdmin, asyncHandler(async (req, res) => {
  const filters = ['c.agency_id = $1'];
  const params = [req.user.agency_id];
  let pi = 2;

  if (req.query.unmatched === '1') filters.push('c.matched_id IS NULL');
  if (req.query.low_score === '1') filters.push('c.matched_id IS NOT NULL AND c.matched_score < 0.6');

  const interval = rangeToInterval(req.query.range);
  if (interval) filters.push(`c.created_at >= now() - interval '${interval}'`);

  if (req.query.search && req.query.search.trim()) {
    filters.push(`c.question ILIKE $${pi++}`);
    params.push('%' + req.query.search.trim() + '%');
  }

  const where = 'WHERE ' + filters.join(' AND ');

  const sql = `
    SELECT trim(lower(c.question)) AS qkey,
           min(c.question)         AS sample_question,
           count(*)::int            AS freq,
           max(c.created_at)        AS last_asked,
           bool_or(c.matched_id IS NULL)         AS ever_unmatched,
           avg(c.matched_score) FILTER (WHERE c.matched_score IS NOT NULL) AS avg_score,
           array_agg(DISTINCT c.source) FILTER (WHERE c.source IS NOT NULL) AS sources
      FROM bot_conversations c
      ${where}
     GROUP BY trim(lower(c.question))
     ORDER BY freq DESC, last_asked DESC
     LIMIT 100
  `;
  const r = await supabase.pool.query(sql, params);
  res.json(r.rows);
}));

// ════════════════════════════════════════════════════════════════════════
// GET /stats — admin dashboard KPIs
// ?range=7d|30d|all (default 7d)
// ════════════════════════════════════════════════════════════════════════
router.get('/stats', requireAdmin, asyncHandler(async (req, res) => {
  const interval = rangeToInterval(req.query.range || '7d') || '30 days';
  const params = [req.user.agency_id];

  const totalRes = await supabase.pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE matched_id IS NOT NULL)::int AS answered,
      count(*) FILTER (WHERE matched_id IS NULL)::int    AS unanswered,
      count(*) FILTER (WHERE source = 'kb')::int         AS kb_count,
      count(*) FILTER (WHERE source = 'kb+query')::int   AS query_count,
      count(*) FILTER (WHERE source = 'llm')::int        AS llm_count,
      count(*) FILTER (WHERE source = 'refused')::int    AS refused_count,
      sum(tokens_in)::int AS tokens_in,
      sum(tokens_out)::int AS tokens_out,
      avg(matched_score) FILTER (WHERE matched_score IS NOT NULL)::float AS avg_score
    FROM bot_conversations
    WHERE agency_id = $1 AND created_at >= now() - interval '${interval}'
  `, params);

  const dailyRes = await supabase.pool.query(`
    SELECT date_trunc('day', created_at)::date AS day,
           count(*)::int AS total,
           count(*) FILTER (WHERE matched_id IS NULL)::int AS unanswered
      FROM bot_conversations
     WHERE agency_id = $1 AND created_at >= now() - interval '${interval}'
     GROUP BY 1 ORDER BY 1
  `, params);

  const topRes = await supabase.pool.query(`
    SELECT trim(lower(question)) AS qkey,
           min(question) AS sample_question,
           count(*)::int AS freq,
           bool_or(matched_id IS NULL) AS ever_unmatched
      FROM bot_conversations
     WHERE agency_id = $1 AND created_at >= now() - interval '${interval}'
     GROUP BY 1
     ORDER BY freq DESC
     LIMIT 10
  `, params);

  res.json({
    range: req.query.range || '7d',
    totals: totalRes.rows[0],
    daily: dailyRes.rows,
    top_questions: topRes.rows,
  });
}));

// ════════════════════════════════════════════════════════════════════════
// GET /closest-match?question=... — admin: nearest existing KB entry
// Used by the "teach from log" form to prefill the answer field as a draft.
// ════════════════════════════════════════════════════════════════════════
router.get('/closest-match', requireAdmin, asyncHandler(async (req, res) => {
  const q = String(req.query.question || '').trim().slice(0, 500);
  if (!q) return res.json(null);

  const r = await supabase.pool.query(`
    SELECT id, question, answer, category, similarity(question, $1) AS score
      FROM bot_knowledge
     WHERE agency_id = $2 AND is_active = TRUE
     ORDER BY score DESC
     LIMIT 1
  `, [q, req.user.agency_id]);

  const row = r.rows[0];
  if (!row || row.score < 0.15) return res.json(null);
  res.json({
    id: row.id,
    question: row.question,
    answer: row.answer,
    category: row.category,
    score: Number(row.score.toFixed(2)),
  });
}));

// ════════════════════════════════════════════════════════════════════════
// POST /suggest-answer — admin: Claude drafts an answer for the admin to
// edit/approve. Uses BYOK Anthropic key. Independent of bot_llm_enabled —
// this is an admin authoring tool, not user-facing inference.
// ════════════════════════════════════════════════════════════════════════
router.post('/suggest-answer', requireAdmin, asyncHandler(async (req, res) => {
  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'প্রশ্ন দিন' });
  }
  const ctx = await loadAgencyContext(req.user.agency_id);

  // Pull a few related KB entries to give Claude domain context
  const kbRes = await supabase.pool.query(`
    SELECT question, answer
      FROM bot_knowledge
     WHERE agency_id = $1 AND is_active = TRUE
     ORDER BY similarity(question, $2) DESC
     LIMIT 5
  `, [req.user.agency_id, question.trim()]);

  const { suggestAnswer } = require('../lib/botLlm');
  const result = await suggestAnswer({
    question: question.trim().slice(0, 500),
    agencyId: req.user.agency_id,
    agencyName: ctx.agencyName,
    relatedKb: kbRes.rows,
  });

  if (!result.ok) {
    const code = result.error === 'no_credential' ? 400 : 502;
    return res.status(code).json({
      error: result.error === 'no_credential'
        ? 'Anthropic API key configure করা নেই — Settings → Integrations-এ যোগ করুন'
        : 'AI suggest ব্যর্থ — পরে আবার চেষ্টা করুন',
      code: result.error,
    });
  }

  res.json({ suggested_answer: result.text, tokens_in: result.tokensIn, tokens_out: result.tokensOut });
}));

module.exports = router;
