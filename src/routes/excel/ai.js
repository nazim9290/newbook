/**
 * ai.js — AI-powered Excel analysis routes
 *
 * POST /ai-analyze              — Upload/existing template → AI placeholder suggestions
 * POST /ai-insert-placeholders  — Approved suggestions → insert {{}} → .xlsx download
 */

const express = require("express");
const ExcelJS = require("exceljs");
const fs = require("fs");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { upload } = require("./_shared");
const { sanitize, getCellText } = require("../../lib/excel/cellUtils");
const { getTemplateBuffer } = require("../../lib/excel/templateFiller");
const {
  parseTemplateForAI,
  analyzeWithClaude,
  detectMappings,
} = require("../../lib/excel/aiAnalyzer");

const router = express.Router();
router.use(auth);

// ================================================================
// POST /api/excel/ai-analyze
// Upload বা existing template → AI analysis → suggestions return
// ================================================================
router.post("/ai-analyze", upload.single("file"), asyncHandler(async (req, res) => {
  const { agency_id } = req.user;
  let templateBuffer = null;
  let templateId = null;
  let schoolName = "";

  // Option 1: existing template ID
  if (req.body.template_id) {
    templateId = req.body.template_id;
    const { data: tmpl } = await supabase.from("excel_templates").select("*").eq("id", templateId).eq("agency_id", agency_id).single();
    if (!tmpl) return res.status(404).json({ error: "Template not found" });
    templateBuffer = getTemplateBuffer(tmpl.file_url || tmpl.file_path);
    schoolName = tmpl.school_name || "";
    if (!templateBuffer) return res.status(400).json({ error: "Template file not found on server" });
  }
  // Option 2: new file upload
  else if (req.file) {
    templateBuffer = fs.readFileSync(req.file.path);
    schoolName = req.body.school_name || req.file.originalname;
  }
  else {
    return res.status(400).json({ error: "template_id or file required" });
  }

  // ExcelJS দিয়ে workbook load
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(templateBuffer);
  } catch (err) {
    return res.status(400).json({ error: "Excel file parse failed: " + err.message });
  }

  // Stage 1-2: Parse cells + merge info
  const sheetData = parseTemplateForAI(workbook);
  const totalCells = sheetData.reduce((s, sh) => s + sh.cells.length, 0);

  if (totalCells === 0) {
    return res.status(400).json({ error: "Empty Excel file — no cells found" });
  }

  // Stage 3: Claude AI analysis
  const aiResult = await analyzeWithClaude(sheetData);

  if (!aiResult) {
    // Fallback: rule-based detection
    console.log("[AI Excel] AI failed, falling back to rule-based detection");
    const allCells = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
        row.eachCell({ includeEmpty: false }, (cell, colNum) => {
          allCells.push({ sheet: sheet.name, row: rowNum, col: colNum, text: getCellText(cell) });
        });
      });
    });
    const fallback = detectMappings(allCells, workbook);
    return res.json({
      suggestions: fallback.map(m => ({
        cellRef: m.cell, sheet: m.sheet, field: m.field || "",
        modifier: "", confidence: m.field ? "medium" : "low",
        reasoning: `Rule-based: label "${m.label}"`,
        label: m.label,
      })),
      stats: { total: fallback.length, high: 0, medium: fallback.filter(m => m.field).length, low: fallback.filter(m => !m.field).length },
      engine: "rule-based",
    });
  }

  // Label enrich — cell text label যোগ করো suggestion-এ
  const cellTextMap = {};
  sheetData.forEach(sh => sh.cells.forEach(c => { cellTextMap[`${sh.sheet}:${c.ref}`] = c.text; }));
  aiResult.suggestions.forEach(s => {
    // Label: adjacent label cell-এর text (AI reasoning থেকে বা cell map থেকে)
    if (!s.label) {
      // পাশের cell-এ label খোঁজো
      const match = (s.reasoning || "").match(/(?:Adjacent to|next to|label)\s+"?([^"]+)"?/i);
      s.label = match ? match[1] : "";
    }
  });

  res.json({ ...aiResult, engine: "claude-haiku", schoolName });
}));

// ================================================================
// POST /api/excel/ai-insert-placeholders
// Approved suggestions → Excel-এ {{placeholder}} insert → download
// DB-তে save না — সরাসরি .xlsx ডাউনলোড
// ================================================================
router.post("/ai-insert-placeholders", upload.single("file"), asyncHandler(async (req, res) => {
  const { suggestions, school_name } = req.body;
  const parsedSuggestions = typeof suggestions === "string" ? JSON.parse(suggestions) : suggestions;

  if (!parsedSuggestions || !parsedSuggestions.length) {
    return res.status(400).json({ error: "No suggestions provided" });
  }

  // File upload থেকে buffer
  if (!req.file) return res.status(400).json({ error: "Excel file required" });
  const templateBuffer = fs.readFileSync(req.file.path);

  // Workbook load
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  // Insert {{placeholders}} into approved cells
  let insertedCount = 0;
  parsedSuggestions.forEach(s => {
    if (!s.cellRef || !s.field) return;
    const sheet = s.sheet ? workbook.getWorksheet(s.sheet) : workbook.worksheets[0];
    if (!sheet) return;
    try {
      const cell = sheet.getCell(s.cellRef);
      const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
      cell.value = s.modifier ? `{{${s.field}${s.modifier}}}` : `{{${s.field}}}`;
      cell.style = oldStyle;
      insertedCount++;
    } catch (err) {
      console.error(`[AI Insert] Cell ${s.cellRef} error:`, err.message);
    }
  });

  // Excel buffer → download response
  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `${sanitize(school_name || "template")}_with_placeholders.xlsx`;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));

  // Cleanup uploaded temp file
  try { fs.unlinkSync(req.file.path); } catch {}
  console.log(`[AI Insert] ${insertedCount} placeholders inserted, downloading ${fileName}`);
}));

module.exports = router;
