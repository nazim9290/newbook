/**
 * pdfPlaceholders.js — scan a PDF for {{placeholder}} text occurrences.
 *
 * Used by:
 *   - routes/super-admin.js     (upload time → detect unique keys)
 *   - routes/pdfTemplates.js    (generate time → find positions to overlay)
 *
 * Returns: [{ key, rawText, page, x, y, width, height, fontSize, source }, ...]
 *   - x, y are in PDF coordinates (origin bottom-left, y = baseline)
 *   - source: "content" (drawn text in /Contents stream) or "annotation" (FreeText annotation)
 *
 * Notes:
 *   - {{...}} is matched globally, multiple per text item OK
 *   - For multi-character placeholders inside a wider text item, x position is approximated
 *     by linear-interpolating into item.width by char count — fine for visa-form blanks
 *     where the placeholder is usually the only text in the item.
 *   - pdfjs-dist v3 legacy build (CommonJS) — runs in Node without a worker.
 */

const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// Disable worker — Node runs synchronously
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
  __dirname, "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.js"
);

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

async function loadDoc(pdfBytes) {
  const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  return pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;
}

async function scanPdfPlaceholders(pdfBytes) {
  const doc = await loadDoc(pdfBytes);
  const placeholders = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);

    // 1) Drawn content text
    let tc = null;
    try { tc = await page.getTextContent(); } catch { tc = { items: [] }; }
    for (const item of tc.items) {
      if (!item || typeof item.str !== "string" || !item.str) continue;
      const matches = [...item.str.matchAll(PLACEHOLDER_RE)];
      if (matches.length === 0) continue;

      const tr = item.transform || [1, 0, 0, 1, 0, 0];
      const a = tr[0], b = tr[1], e = tr[4], f = tr[5];
      const fontSize = Math.hypot(a, b) || 11;
      const totalLen = item.str.length || 1;

      for (const m of matches) {
        const startIdx = m.index || 0;
        const matchStr = m[0];
        const xOffset = item.width * (startIdx / totalLen);
        const matchWidth = item.width * (matchStr.length / totalLen);
        placeholders.push({
          key: m[1].trim(),
          rawText: matchStr,
          page: pageNum,
          x: e + xOffset,
          y: f,
          width: matchWidth,
          height: item.height || fontSize,
          fontSize,
          source: "content",
        });
      }
    }

    // 2) FreeText annotations (some editors put inserted text here, not in content)
    let annotations = [];
    try { annotations = await page.getAnnotations(); } catch { annotations = []; }
    for (const ann of annotations) {
      const txt = (ann?.contents) || (ann?.contentsObj?.str) || "";
      if (!txt) continue;
      const matches = [...txt.matchAll(PLACEHOLDER_RE)];
      if (matches.length === 0) continue;

      const rect = ann.rect || [0, 0, 0, 0];
      const x1 = rect[0], y1 = rect[1], x2 = rect[2], y2 = rect[3];
      const w = Math.max(0, x2 - x1);
      const h = Math.max(0, y2 - y1);
      const fontSize = Math.max(9, h * 0.7);

      for (const m of matches) {
        placeholders.push({
          key: m[1].trim(),
          rawText: m[0],
          page: pageNum,
          x: x1 + 1,
          y: y1 + 2,
          width: w,
          height: h,
          fontSize,
          source: "annotation",
        });
      }
    }
  }

  await doc.destroy?.().catch(() => {});
  return placeholders;
}

// Unique placeholder key list (for upload-time mapping editor)
function uniqueKeys(placeholders) {
  const seen = new Set();
  const out = [];
  for (const p of placeholders) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(p.key);
  }
  return out;
}

module.exports = { scanPdfPlaceholders, uniqueKeys };
