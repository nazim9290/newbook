/**
 * ai-assistant.js — AI Counselor Assistant (Phase 5 F12)
 *
 * Mounted at /api/ai-assistant
 *
 * Uses agency's BYOK Anthropic key (via lib/integrations.getCredential).
 * Falls back to platform key on shared instance with quota enforcement.
 *
 * Routes:
 *   GET  /threads             — list user's chat threads
 *   POST /threads             — create new thread (with optional context)
 *   GET  /threads/:id         — load thread + messages
 *   POST /threads/:id/message — user sends message → assistant replies
 *   DELETE /threads/:id       — delete thread
 *   GET  /context/:type/:id   — fetch context payload (student/visitor) for the AI
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const integrations = require("../lib/integrations");

const router = express.Router();
router.use(auth);

const MODEL = "claude-haiku-4-5-20251001";  // fast + cheap for counselor Q&A
const MAX_HISTORY = 20;                       // last 20 messages sent to LLM
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are AgencyOS Assistant, helping a Bangladeshi study-abroad agency counselor.
Be concise and practical. Bengali or English replies are both fine — match the user's language.
You may be given context about a specific student or visitor — use it to answer specifically.
When suggesting actions, be specific (e.g., "follow up Tuesday", "request passport scan", "send school deadline reminder").
Never make up student data — if you don't have the information, say so.`;

// ────────────────────────────────────────────────────────────
// Build context payload from a linked record
// ────────────────────────────────────────────────────────────
async function buildContext(agencyId, contextType, contextId) {
  if (!contextType || !contextId) return null;

  if (contextType === "student") {
    const { rows } = await supabase.pool.query(`
      SELECT s.id, s.name_en, s.name_bn, s.status, s.country, s.dob,
             s.passport_number, s.passport_expiry, s.visa_expiry, s.visa_type,
             sch.name_en AS school_name,
             (SELECT COALESCE(SUM(amount),0) FROM payments WHERE student_id = s.id) AS paid_total,
             (SELECT COALESCE(SUM(amount),0) FROM fee_items WHERE student_id = s.id) AS fee_total
      FROM students s
      LEFT JOIN schools sch ON sch.id = s.school_id
      WHERE s.id = $1 AND s.agency_id = $2
    `, [contextId, agencyId]);
    return rows[0] || null;
  }
  if (contextType === "visitor") {
    const { rows } = await supabase.pool.query(`
      SELECT id, name, name_en, name_bn, status, phone, email, country, agent_name,
             interested_countries, visit_date, last_follow_up, next_follow_up, notes
      FROM visitors WHERE id = $1 AND agency_id = $2
    `, [contextId, agencyId]);
    return rows[0] || null;
  }
  if (contextType === "school") {
    const { rows } = await supabase.pool.query(`
      SELECT id, name_en, name_jp, country, city, tuition_y1, shoukai_fee,
             min_jp_level, deadline_april, deadline_october, has_dormitory, commission_rate
      FROM schools WHERE id = $1 AND agency_id = $2
    `, [contextId, agencyId]);
    return rows[0] || null;
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────

router.get("/threads", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT id, title, context_type, context_id, created_at, updated_at,
           (SELECT COUNT(*)::int FROM chat_messages WHERE thread_id = chat_threads.id) AS message_count
    FROM chat_threads
    WHERE user_id = $1
    ORDER BY updated_at DESC LIMIT 50
  `, [req.user.id]);
  res.json(rows);
}));

router.post("/threads", asyncHandler(async (req, res) => {
  const { title, context_type, context_id } = req.body || {};
  const { rows } = await supabase.pool.query(`
    INSERT INTO chat_threads (agency_id, user_id, title, context_type, context_id)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `, [req.user.agency_id, req.user.id, title || "New conversation", context_type || "general", context_id || null]);
  res.status(201).json(rows[0]);
}));

router.get("/threads/:id", asyncHandler(async (req, res) => {
  const { rows: t } = await supabase.pool.query(
    `SELECT * FROM chat_threads WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!t.length) return res.status(404).json({ error: "Thread পাওয়া যায়নি" });

  const { rows: msgs } = await supabase.pool.query(
    `SELECT id, role, content, created_at FROM chat_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ thread: t[0], messages: msgs });
}));

router.delete("/threads/:id", asyncHandler(async (req, res) => {
  await supabase.pool.query(
    `DELETE FROM chat_threads WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
}));

// POST /threads/:id/message — user message → assistant reply
router.post("/threads/:id/message", asyncHandler(async (req, res) => {
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "Message দিন" });

  // Load thread + verify ownership
  const { rows: t } = await supabase.pool.query(
    `SELECT * FROM chat_threads WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!t.length) return res.status(404).json({ error: "Thread পাওয়া যায়নি" });
  const thread = t[0];

  // Get Anthropic credential (BYOK or platform fallback)
  let cred;
  try {
    cred = await integrations.getCredential(req.user.agency_id, "anthropic");
  } catch (err) {
    return res.status(err.code === "QUOTA_EXCEEDED" ? 402 : 503).json({
      error: err.message, code: err.code, service: err.service,
    });
  }

  // Save user message
  await supabase.pool.query(
    `INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', $2)`,
    [thread.id, content.trim()]
  );

  // Build conversation history (last MAX_HISTORY)
  const { rows: history } = await supabase.pool.query(
    `SELECT role, content FROM chat_messages WHERE thread_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [thread.id, MAX_HISTORY]
  );
  const messages = history.reverse().map(m => ({ role: m.role, content: m.content }));

  // Build system prompt with context if any
  let systemPrompt = SYSTEM_PROMPT;
  if (thread.context_type && thread.context_id) {
    const ctxData = await buildContext(req.user.agency_id, thread.context_type, thread.context_id);
    if (ctxData) {
      systemPrompt += `\n\nContext (${thread.context_type}):\n${JSON.stringify(ctxData, null, 2)}`;
    }
  }

  // Call Anthropic API
  let assistantText = "";
  let tokensIn = 0, tokensOut = 0;
  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cred.api_key || cred.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      }),
    });
    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      throw new Error(`Anthropic ${apiRes.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await apiRes.json();
    assistantText = data.content?.[0]?.text || "";
    tokensIn = data.usage?.input_tokens || 0;
    tokensOut = data.usage?.output_tokens || 0;
  } catch (err) {
    console.error("[ai-assistant]", err.message);
    return res.status(502).json({ error: `AI service unavailable: ${err.message}` });
  }

  // Track usage if platform-keyed
  if (cred.source === "platform") {
    integrations.incrementUsage(req.user.agency_id, "anthropic").catch(() => {});
  }

  // Save assistant reply
  const { rows: msgRow } = await supabase.pool.query(`
    INSERT INTO chat_messages (thread_id, role, content, tokens_in, tokens_out)
    VALUES ($1, 'assistant', $2, $3, $4) RETURNING id, role, content, created_at
  `, [thread.id, assistantText, tokensIn, tokensOut]);

  // Bump thread updated_at + auto-title from first message
  if (!thread.title || thread.title === "New conversation") {
    const autoTitle = content.trim().slice(0, 60);
    await supabase.pool.query(
      `UPDATE chat_threads SET title = $1, updated_at = NOW() WHERE id = $2`,
      [autoTitle, thread.id]
    );
  } else {
    await supabase.pool.query(
      `UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`, [thread.id]
    );
  }

  res.json({
    message: msgRow[0],
    usage: { tokens_in: tokensIn, tokens_out: tokensOut, source: cred.source },
  });
}));

module.exports = router;
