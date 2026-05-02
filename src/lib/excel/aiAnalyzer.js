/**
 * aiAnalyzer.js — AI-powered Excel template analysis
 *
 * parseTemplateForAI: ExcelJS workbook থেকে structured cell/merge data extract
 * buildAIPrompt: Compact cell map + system fields → Claude prompt
 * analyzeWithClaude: Claude Haiku API call → placeholder suggestions
 * detectMappings: Rule-based fallback detector (AI fail হলে)
 */

const { colLetter, colToNum, getCellText, isLabel, autoDetect } = require("./cellUtils");
const { SYSTEM_FIELDS, ALL_FIELD_KEYS } = require("./systemContext");

// Smart detection of mapping targets for real Japanese school forms
function detectMappings(allCells, workbook) {
  const suggestions = [];
  const seen = new Set();

  // Analyze each sheet
  workbook.eachSheet((sheet) => {
    const sheetName = sheet.name;
    const sheetCells = allCells.filter((c) => c.sheet === sheetName);

    // Scan every row for label → data patterns
    const maxRow = Math.max(...sheetCells.map((c) => c.row), 0);
    const maxCol = Math.max(...sheetCells.map((c) => c.col), 0);

    for (let row = 1; row <= maxRow + 2; row++) {
      for (let col = 1; col <= maxCol + 5; col++) {
        const cell = sheet.getCell(row, col);
        const text = getCellText(cell);
        if (!text) continue;

        const cellRef = `${colLetter(col)}${row}`;
        const detected = autoDetect(text);

        // Check if this looks like a label (Japanese/English field name)
        if (!isLabel(text)) continue;

        // Strategy: find the best "data cell" for this label
        let targetRef = null;
        let targetLabel = text;

        // 1. Check right neighbor (most common: label left, data right)
        for (let dc = 1; dc <= 3; dc++) {
          const rightRef = `${colLetter(col + dc)}${row}`;
          const rightText = getCellText(sheet.getCell(row, col + dc));

          // Right cell is empty → data goes here
          if (!rightText) {
            targetRef = rightRef;
            break;
          }
          // Right cell has same text → it's a "data placeholder" (paired pattern)
          if (rightText === text) {
            targetRef = rightRef;
            break;
          }
          // Right cell has data that looks like user-entered content
          if (rightText && !isLabel(rightText) && rightText.length > 1) {
            targetRef = rightRef;
            break;
          }
        }

        // 2. Check below (table pattern: header on top, data below)
        if (!targetRef) {
          const belowText = getCellText(sheet.getCell(row + 1, col));
          if (belowText && !isLabel(belowText)) {
            targetRef = `${colLetter(col)}${row + 1}`;
          } else if (!belowText) {
            targetRef = `${colLetter(col)}${row + 1}`;
          }
        }

        // 3. Fallback: data replaces the label cell itself
        if (!targetRef) {
          targetRef = cellRef;
        }

        if (!seen.has(targetRef)) {
          suggestions.push({
            cell: targetRef,
            label: targetLabel,
            labelCell: cellRef,
            sheet: sheetName,
            field: detected,
          });
          seen.add(targetRef);
        }
      }
    }
  });

  return suggestions;
}

/**
 * parseTemplateForAI — Excel workbook থেকে সব cell + merge info extract
 * AI-friendly structured format-এ convert করে
 */
function parseTemplateForAI(workbook) {
  const sheets = [];

  workbook.eachSheet((sheet) => {
    const sheetName = sheet.name;
    // Merge ranges collect
    const merges = (sheet.model?.merges || []).map(m => {
      // ExcelJS merge format: "A1:D1" or { top, left, bottom, right }
      if (typeof m === "string") return m;
      if (m.model) return m.model;
      return null;
    }).filter(Boolean);

    // Merge lookup — কোন cell কোন range-এর অংশ
    const mergeMap = {};
    merges.forEach(range => {
      const r = typeof range === "string" ? range : `${colLetter(range.left)}${range.top}:${colLetter(range.right)}${range.bottom}`;
      const parts = r.split(":");
      if (parts.length !== 2) return;
      // Master cell = top-left (first part)
      mergeMap[parts[0]] = { range: r, isMaster: true };
      // Parse range to mark slave cells
      const [startCell, endCell] = parts;
      const startMatch = startCell.match(/^([A-Z]+)(\d+)$/);
      const endMatch = endCell.match(/^([A-Z]+)(\d+)$/);
      if (!startMatch || !endMatch) return;
      const startCol = colToNum(startMatch[1]), endCol = colToNum(endMatch[1]);
      const startRow = parseInt(startMatch[2]), endRow = parseInt(endMatch[2]);
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const ref = `${colLetter(c)}${r}`;
          if (ref !== parts[0]) mergeMap[ref] = { range: `${parts[0]}:${parts[1]}`, isMaster: false, master: parts[0] };
        }
      }
    });

    const cells = [];
    const maxRow = sheet.rowCount || 100;
    const maxCol = sheet.columnCount || 20;

    for (let row = 1; row <= Math.min(maxRow, 200); row++) {
      for (let col = 1; col <= Math.min(maxCol, 30); col++) {
        const cell = sheet.getCell(row, col);
        const text = getCellText(cell);
        const ref = `${colLetter(col)}${row}`;

        // Slave cells skip — শুধু master cell report করব
        if (mergeMap[ref] && !mergeMap[ref].isMaster) continue;

        const isEmpty = !text;
        const merge = mergeMap[ref];

        if (text || (isEmpty && merge)) {
          // Type classification:
          // label = form label (氏名, Date of birth, etc.)
          // suffix = year/month/day suffix (年, 月, 日)
          // data = cell that contains actual student data (should be replaced)
          // data_candidate = empty cell where data should go
          let type = "other";
          if (isEmpty) type = "data_candidate";
          else if (isLabel(text)) type = "label";
          else if (/^[年月日]$/.test(text)) type = "suffix";
          else if (!isEmpty && !isLabel(text) && text.length > 0) type = "data"; // student data

          cells.push({
            ref,
            text: text || "",
            isEmpty,
            mergeRange: merge?.range || null,
            type,
          });
        }
      }
    }

    // Empty cell যেগুলো merge নয় কিন্তু label-এর পাশে — data candidate হিসেবে mark
    // (AI নিজেই বুঝবে, তাই এখানে basic classification যথেষ্ট)

    sheets.push({ sheet: sheetName, cells, merges: merges.map(m => typeof m === "string" ? m : `${colLetter(m.left)}${m.top}:${colLetter(m.right)}${m.bottom}`) });
  });

  return sheets;
}

/**
 * buildAIPrompt — Cell map + system fields → Claude prompt
 * Token-efficient compact format ব্যবহার করে
 */
function buildAIPrompt(sheetData) {
  // System fields list — compact
  const fieldList = SYSTEM_FIELDS.map(g =>
    `[${g.group}]: ${g.fields.map(f => f.key).join(", ")}`
  ).join("\n");

  // Cell map — label + data/empty cells (token optimization)
  // label, suffix, data (filled student data), data_candidate (empty) সব include
  const sheetText = sheetData.map(s => {
    const lines = [`\n=== Sheet: ${s.sheet} ===`];
    s.cells.forEach(c => {
      if (c.type === "label" || c.type === "suffix") {
        lines.push(`${c.ref}: "${c.text}" [${c.type}]`);
      } else if (c.type === "data_candidate") {
        lines.push(`${c.ref}: [EMPTY${c.mergeRange ? `, merged ${c.mergeRange}` : ""}]`);
      } else if (c.type === "data") {
        // Filled data — truncate long values, mask encrypted hashes
        const display = c.text.length > 40 ? c.text.substring(0, 30) + "..." : c.text;
        lines.push(`${c.ref}: "${display}" [data${c.mergeRange ? `, merged ${c.mergeRange}` : ""}]`);
      }
    });
    return lines.join("\n");
  }).join("\n");

  // Token limit — prompt খুব বড় হলে truncate
  const maxPromptChars = 12000;
  const truncatedSheetText = sheetText.length > maxPromptChars
    ? sheetText.substring(0, maxPromptChars) + "\n... (truncated, analyze what's visible)"
    : sheetText;

  return `You are an expert at analyzing Japanese school admission forms (入学願書, 経費支弁書, 履歴書) and study abroad application templates.

TASK: Analyze this Excel template and identify which cells should contain student data placeholders. The template may be BLANK (empty data cells) or FILLED (with sample student data). For BOTH empty cells and cells with existing data, suggest the correct system field to replace them with placeholders.

AVAILABLE SYSTEM FIELDS:
${fieldList}

AVAILABLE MODIFIERS (append to field key):
- :year, :month, :day — for date fields split into separate year/month/day cells
- :first, :last — for name fields split into first/last name
- :jp — Japanese date format (年月日)

TEMPLATE STRUCTURE:
${truncatedSheetText}

RULES:
1. Map BOTH empty cells AND cells with existing student data (type="data") — replace them with placeholders
2. Use spatial context: labels are typically to the LEFT or ABOVE data cells
3. Cells marked [data] contain sample student info — they should ALSO be mapped to the correct field
4. Japanese date pattern: 生年月日 followed by [EMPTY]年[EMPTY]月[EMPTY]日 → use dob:year, dob:month, dob:day
4. Education sections (学歴): school name, location, entrance date, graduation date pattern
5. Sponsor sections (経費支弁者): map to sponsor_* fields
6. If a label says ふりがな or カタカナ → name_katakana
7. If a label says ローマ字 or Alphabet → name_en
8. Merged empty cells = one data field (use the master cell ref)
9. Set confidence: "high" if label clearly matches, "medium" if ambiguous, "low" if uncertain
10. Skip cells meant for stamps (印), photos (写真), office use (事務使用)
11. If a cell has encrypted/hash-like text (long hex strings), it should STILL be mapped if adjacent to a known label
12. For family sections: father_name_en, father_dob, father_occupation, mother_name_en, mother_dob, mother_occupation
13. For sponsor (経費支弁者) sections: sponsor_name, sponsor_name_en, sponsor_relationship, sponsor_phone, sponsor_address, sponsor_company, sponsor_income_y1/y2/y3, sponsor_tax_y1/y2/y3

Return ONLY a valid JSON array:
[{"cellRef":"B3","sheet":"Sheet1","field":"name_en","modifier":"","confidence":"high","reasoning":"Adjacent to 氏名 label"}]`;
}

/**
 * analyzeWithClaude(agencyId, sheetData) — Claude Haiku API call.
 * Uses BYOK resolver — agency's own key first, platform fallback in shared
 * mode. Returns null if no key available (caller falls back to rule-based).
 */
async function analyzeWithClaude(agencyId, sheetData) {
  if (!agencyId) {
    console.error("[AI Excel] analyzeWithClaude called without agencyId");
    return null;
  }

  const { getCredential } = require("../integrations");
  let creds;
  try {
    creds = await getCredential(agencyId, "anthropic");
  } catch (e) {
    console.warn(`[AI Excel] anthropic unavailable for ${agencyId}: ${e.code || e.message}`);
    return null;
  }

  const prompt = buildAIPrompt(sheetData);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": creds.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("[AI Excel] API error:", response.status, errText.substring(0, 200));
      return null;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "";
    console.log("[AI Excel] Response length:", text.length, "chars, first 200:", text.substring(0, 200));

    // JSON extract — multiple strategies
    // 1. Markdown code block: ```json [...] ```
    let jsonStr = null;
    const codeBlockMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1];
    // 2. Direct array: [...]
    if (!jsonStr) { const m = text.match(/\[[\s\S]*\]/); if (m) jsonStr = m[0]; }
    // 3. Object with suggestions key: {"suggestions": [...]}
    if (!jsonStr) {
      const objMatch = text.match(/\{[\s\S]*"suggestions"\s*:\s*(\[[\s\S]*?\])[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[1];
    }

    if (!jsonStr) {
      console.error("[AI Excel] No JSON found in response. First 500 chars:", text.substring(0, 500));
      return null;
    }

    let suggestions;
    try {
      suggestions = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("[AI Excel] JSON parse error:", parseErr.message, "JSON start:", jsonStr.substring(0, 200));
      return null;
    }

    if (!Array.isArray(suggestions)) {
      console.error("[AI Excel] Parsed result is not array:", typeof suggestions);
      return null;
    }

    // Validate — শুধু known field keys রাখো
    const validated = suggestions.filter(s => {
      const baseField = (s.field || "").split(":")[0];
      return ALL_FIELD_KEYS.includes(baseField) || ALL_FIELD_KEYS.includes(s.field);
    }).map(s => ({
      cellRef: s.cellRef || s.cell,
      sheet: s.sheet || "",
      field: s.field || "",
      modifier: s.modifier || "",
      confidence: ["high", "medium", "low"].includes(s.confidence) ? s.confidence : "medium",
      reasoning: s.reasoning || "",
    }));

    // Token usage log
    const usage = result.usage || {};
    console.log(`[AI Excel] ${validated.length} suggestions, tokens: ${usage.input_tokens || "?"}in/${usage.output_tokens || "?"}out`);

    return {
      suggestions: validated,
      stats: {
        total: validated.length,
        high: validated.filter(s => s.confidence === "high").length,
        medium: validated.filter(s => s.confidence === "medium").length,
        low: validated.filter(s => s.confidence === "low").length,
      },
      usage,
    };
  } catch (err) {
    console.error("[AI Excel Error]", err.message);
    return null;
  }
}

module.exports = {
  detectMappings,
  parseTemplateForAI,
  buildAIPrompt,
  analyzeWithClaude,
};
