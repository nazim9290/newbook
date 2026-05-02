/**
 * botLlm.js — Claude fallback for the help bot.
 *
 * Only fires when:
 *   1. agency_settings.bot_llm_enabled = TRUE for this agency
 *   2. The agency has a BYOK Anthropic credential configured
 *   3. KB lookup returned no high-confidence match
 *
 * The system prompt enforces three NON-NEGOTIABLE rules:
 *   1. Off-topic refusal — only AgencyBook-related questions
 *   2. Tenant isolation — only this agency's data
 *   3. Permission scope — only data the user has permission to read
 *
 * We never give Claude any cross-agency data, raw PII, or capability to
 * call the database. It only sees: agency name, user role+name, page
 * context, top-N KB matches (low-confidence), and any pre-fetched
 * permission-checked summary numbers. That's it.
 */

const integrations = require("./integrations");

const MODEL = process.env.BOT_LLM_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = parseInt(process.env.BOT_LLM_MAX_TOKENS || "400", 10);

function buildSystemPrompt({ agencyName, user, pageContext, kbMatches, dataSummary }) {
  const userRole = user.role || "staff";
  const userName = user.name || "user";

  const kbBlock = (kbMatches || []).length
    ? (kbMatches || []).map((m, i) =>
        `[${i + 1}] Q: ${m.question}\n    A: ${m.answer}` +
        (m.category ? ` (category: ${m.category})` : "")
      ).join("\n")
    : "(no matching entries — say so honestly if relevant)";

  const dataBlock = dataSummary && Object.keys(dataSummary).length
    ? Object.entries(dataSummary).map(([k, v]) => `  - ${k}: ${v}`).join("\n")
    : "(no live data fetched for this question)";

  return `You are the AgencyBook help bot for the agency "${agencyName}".
You answer in friendly conversational Bengali (use English technical terms naturally — student, visitor, dashboard, button, etc.). Talk like a helpful real teammate, not a robot. Keep answers concise (2-5 sentences usually). Use markdown bullet/bold sparingly.

═══ NON-NEGOTIABLE RULES ═══
1. ONLY answer questions about AgencyBook (the multi-tenant CRM this user is using). If asked anything else (general knowledge, current events, opinions, math, jokes, politics, religion, weather, other software, code generation), refuse politely in Bengali: "এই বিষয়ে আমি সাহায্য করতে পারি না। শুধু AgencyBook-এর feature/data নিয়ে প্রশ্ন করুন।" Don't try to be helpful by guessing.

2. The current user is **${userName}**, role: **${userRole}**, agency: **${agencyName}**.
   - NEVER mention or reveal data from any other agency.
   - NEVER reference features/menus the user's role can't access.
   - Owner/admin can see everything in this agency. Other roles have limited module access — if a question seems to need data outside the user's scope, say "আপনার role-এ এই data দেখার access নেই — owner/admin-কে জিজ্ঞেস করুন।" Don't speculate.

3. Use ONLY the knowledge base entries and live-data summary provided below. If they don't cover the question, say honestly "এই বিষয়ে আমার কাছে তথ্য নেই — আপনার admin-কে জিজ্ঞেস করুন বা তারা bot-কে শেখাতে পারেন।" NEVER invent features, button names, menu paths, statistics, or capabilities.

═══ CONTEXT ═══
Page user is currently on: ${pageContext || "(unknown)"}

Knowledge base entries (top matches by similarity — may or may not be relevant):
${kbBlock}

Live data already fetched (permission-checked, agency-scoped):
${dataBlock}

═══ STYLE ═══
- Friendly, supportive tone — like a real teammate.
- Bengali primary, English technical terms inline.
- No "As an AI" disclaimers. No "I'm just a bot". Just answer or refuse.
- Short paragraphs. Bullet points only when listing 3+ items.
- Never end with "let me know if you need more help" — that's fluff.`;
}

/**
 * Call Claude with the user's question + structured context.
 * Returns { ok, text, tokensIn, tokensOut, error }.
 *
 * Failure modes (returned as { ok:false, error }):
 *   - 'llm_disabled'     — agency_settings.bot_llm_enabled is false
 *   - 'no_credential'    — no BYOK Anthropic key configured
 *   - 'api_error'        — network/HTTP error from Anthropic
 *   - 'empty_response'   — Claude returned nothing usable
 */
async function askLlm({ question, agencyId, agencyName, user, pageContext, kbMatches, dataSummary, llmEnabled }) {
  if (!llmEnabled) return { ok: false, error: "llm_disabled" };

  // Pull credential — non-fatal: if missing, fall through gracefully.
  let cred;
  try {
    cred = await integrations.getCredential(agencyId, "anthropic");
  } catch (err) {
    return { ok: false, error: "no_credential", detail: err.message };
  }

  const apiKey = cred?.api_key || cred?.apiKey;
  if (!apiKey) return { ok: false, error: "no_credential" };

  const systemPrompt = buildSystemPrompt({ agencyName, user, pageContext, kbMatches, dataSummary });

  let res, body;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });
    body = await res.json();
  } catch (err) {
    console.error("[botLlm] fetch failed:", err.message);
    return { ok: false, error: "api_error", detail: err.message };
  }

  if (!res.ok) {
    console.error("[botLlm] Anthropic", res.status, JSON.stringify(body).slice(0, 300));
    return { ok: false, error: "api_error", status: res.status };
  }

  const text = body.content?.[0]?.text?.trim();
  if (!text) return { ok: false, error: "empty_response" };

  return {
    ok: true,
    text,
    tokensIn: body.usage?.input_tokens || 0,
    tokensOut: body.usage?.output_tokens || 0,
  };
}

module.exports = { askLlm, buildSystemPrompt, MODEL };
