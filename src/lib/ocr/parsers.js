/**
 * parsers.js — OCR text থেকে fields extract-এর generic parsers
 *
 * genericParse(text, fieldConfigs): config অনুযায়ী fields extract
 * parseDate(raw): বিভিন্ন format → YYYY-MM-DD
 * detectAndParse(text): DOC_CONFIGS থেকে সঠিক parser বের করে চালায়
 */

const { DOC_CONFIGS } = require("./docConfigs");

/**
 * genericParse(text, fieldConfigs) — OCR text থেকে config অনুযায়ী fields extract করে
 *
 * fieldConfig format:
 *   { key: "name_en", patterns: [/regex/], type: "text"|"date"|"number" }
 *   { key: "subjects", type: "table", pattern: /regex/g, columns: ["Subject","Grade","Point"] }
 */
function genericParse(text, fieldConfigs) {
  const fields = {};

  for (const fc of fieldConfigs) {
    if (fc.type === "table") {
      // Repeatable/table — multiple matches, store as Member1_Col, Member2_Col...
      const regex = new RegExp(fc.pattern.source, fc.pattern.flags);
      let match;
      let idx = 1;
      while ((match = regex.exec(text)) !== null) {
        const cols = fc.columns || [];
        cols.forEach((col, i) => {
          if (match[i + 1]) fields[`Member${idx}_${col}`] = match[i + 1].trim();
        });
        idx++;
      }
      continue;
    }

    // Normal field — try each pattern until one matches
    for (const pat of (fc.patterns || [])) {
      const match = text.match(pat);
      if (match && match[1]) {
        let value = match[1].trim();

        // Type-based post-processing
        if (fc.type === "date") {
          value = parseDate(value);
        } else if (fc.type === "number") {
          value = value.replace(/[\s,]/g, "");
        }

        if (value) {
          fields[fc.key] = value;
          break; // first matching pattern wins
        }
      }
    }
  }

  return fields;
}

/** তারিখ পার্সার — বিভিন্ন ফরম্যাটের তারিখকে YYYY-MM-DD-তে রূপান্তর করে
 *  "08 Jun 1978", "06/08/2023", "13 February, 2022" → "1978-06-08", "2023-08-06", "2022-02-13"
 */
function parseDate(raw) {
  if (!raw) return "";
  const months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
                   jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };

  // "08 Jun 1978" or "13 February, 2022"
  const named = raw.match(/(\d{1,2})\s*(\w{3,}),?\s*(\d{4})/i);
  if (named) {
    const m = months[named[2].toLowerCase().substring(0, 3)];
    if (m) return `${named[3]}-${m}-${named[1].padStart(2, "0")}`;
  }

  // "06/08/2023" or "06-08-2023" (DD/MM/YYYY)
  const numeric = raw.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (numeric) {
    let [, d, m, y] = numeric;
    if (y.length === 2) y = (parseInt(y) > 50 ? "19" : "20") + y;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return raw; // return as-is if can't parse
}

/**
 * detectAndParse — DOC_CONFIGS থেকে সঠিক parser বের করে চালায়
 *   Step 1: detect pattern match — প্রথম match-ই ব্যবহার হবে
 *   Step 2: fallback — সব config try করে সবচেয়ে বেশি field match
 */
function detectAndParse(text) {
  // Step 1: detect pattern match — প্রথম match-ই ব্যবহার হবে
  for (const config of DOC_CONFIGS) {
    if (config.detect.test(text)) {
      if (config.reject && config.reject.test(text)) continue; // reject pattern match করলে skip
      const fields = genericParse(text, config.fields);
      if (config.postProcess) config.postProcess(fields, text);
      const keyCount = (config.confidence || []).filter(k => fields[k]).length;
      fields._confidence = keyCount >= Math.ceil(config.confidence.length * 0.6) ? "high"
                         : keyCount >= 1 ? "medium" : "low";
      return { docType: config.id, fields };
    }
  }

  // Step 2: fallback — সব config try করে সবচেয়ে বেশি field match
  let best = { docType: "unknown", fields: {}, count: 0 };
  for (const config of DOC_CONFIGS) {
    const fields = genericParse(text, config.fields);
    if (config.postProcess) config.postProcess(fields, text);
    const count = Object.keys(fields).filter(k => !k.startsWith("_")).length;
    if (count > best.count) {
      const keyCount = (config.confidence || []).filter(k => fields[k]).length;
      fields._confidence = keyCount >= Math.ceil(config.confidence.length * 0.6) ? "high"
                         : keyCount >= 1 ? "medium" : "low";
      best = { docType: config.id, fields, count };
    }
  }
  return best;
}

module.exports = { genericParse, parseDate, detectAndParse };
