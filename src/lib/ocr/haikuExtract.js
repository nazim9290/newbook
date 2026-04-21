/**
 * haikuExtract.js — Claude Haiku দিয়ে OCR text থেকে structured fields extract
 *
 * Google Vision raw text + frontend expected_fields → Haiku → { docType, fields, confidence }
 * Regex fallback-এর চেয়ে অনেক বেশি accurate — primary engine
 */

async function extractWithHaiku(rawText, docConfigs, expectedFields, docTypeName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // DOC_CONFIGS থেকে সব possible field names + doc types বের করো
  const docTypes = docConfigs.map(c => `${c.id}: ${c.fields.map(f => f.key).join(", ")}`).join("\n");

  // Frontend থেকে আসা expected fields — এগুলোই primary target
  let expectedFieldsInfo = "";
  if (expectedFields && expectedFields.length > 0) {
    expectedFieldsInfo = `\n\nIMPORTANT — The user is filling a "${docTypeName || "document"}" form. Extract these SPECIFIC fields:\n` +
      expectedFields.map(f => `- "${f.key}" (${f.label || f.key}) [${f.type || "text"}]`).join("\n");
  }

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
          content: `You are a document data extractor for a Study Abroad CRM (Bangladesh → Japan/Germany/Korea).

Known document types and their fields:
${docTypes}
${expectedFieldsInfo}

OCR Text:
---
${rawText.substring(0, 4000)}
---

Instructions:
1. Identify the document type
2. Extract ALL matching fields from the text — use the exact field key names listed above
3. For "certificate_type" field: determine what type of certificate this is (e.g., "Birth Certificate", "NID", "SSC", "HSC", "Passport", etc.)
4. Dates: convert to YYYY-MM-DD format (e.g., "07 Oct 2001" → "2001-10-07")
5. Names: ENGLISH UPPERCASE
6. Addresses: combine all parts into one string
7. For select/dropdown fields, pick the best matching option value
8. For "issuing_authority" fields: extract the office/authority that issued the document
9. If a field has multiple lines (like issuing authority), combine them
10. Extract EVERY possible field — even if not 100% sure, include with best guess

Return ONLY valid JSON:
{"doc_type": "type_id", "fields": {"field_key": "value", ...}, "confidence": "high|medium|low"}`
        }],
      }),
    });

    if (!response.ok) {
      console.error("[Haiku] API error:", response.status);
      return null;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "";

    // JSON parse — Haiku response থেকে structured data বের করো
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      docType: parsed.doc_type || "unknown",
      fields: parsed.fields || {},
      confidence: parsed.confidence || "medium",
      engine: "haiku",
    };
  } catch (err) {
    console.error("[Haiku Error]", err.message);
    return null;
  }
}

module.exports = { extractWithHaiku };
