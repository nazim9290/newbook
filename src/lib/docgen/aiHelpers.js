/**
 * aiHelpers.js — AI translation + HTML fallback
 *
 * translateToJapanese: Claude Haiku দিয়ে long English text → Japanese (formal です/ます)
 *   Result cache হয় student record-এ — পরবর্তী call বাঁচে
 *
 * generateHTMLFromFlat: PDF generate fail হলে simple HTML fallback
 */

const { resolveValue } = require("./valueResolver");

// ═══════════════════════════════════════════════════════
// AI Japanese Translation — long text (Purpose of Study etc.)
// ═══════════════════════════════════════════════════════
async function translateToJapanese(text) {
  if (!text || text.length < 20) return text;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return text;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `Translate the following English text to natural Japanese. This is a "Purpose of Study" letter for a Japanese student visa application. Use formal Japanese (です/ます form). Keep paragraph structure. Return ONLY the Japanese translation, nothing else.\n\n${text}`
        }],
      }),
    });
    if (!response.ok) return text;
    const result = await response.json();
    return result.content?.[0]?.text || text;
  } catch {
    return text;
  }
}

// Simple HTML for PDF fallback
function generateHTMLFromFlat(flat, placeholders) {
  const rows = placeholders.map(p => {
    const val = resolveValue(flat, p.field || p.key);
    return `<tr><td style="padding:5px;border:1px solid #ddd;font-weight:bold">${p.key}</td><td style="padding:5px;border:1px solid #ddd">${val}</td></tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:30px}table{width:100%;border-collapse:collapse}h1{font-size:18px}</style></head><body><h1>${flat.name_en || "Student"} — Document</h1><table>${rows}</table><p style="margin-top:30px;font-size:12px">Generated: ${flat.today}</p></body></html>`;
}

module.exports = { translateToJapanese, generateHTMLFromFlat };
