/**
 * templates.js — Excel template CRUD routes
 *
 * POST   /upload-template        — .xlsx upload + {{}} placeholder detect
 * GET    /templates              — list all templates
 * GET    /templates/:id          — single template
 * POST   /templates/:id/mapping  — save placeholder → field mapping
 * DELETE /templates/:id          — delete template + file
 * GET    /system-fields          — available field list (for frontend UI)
 */

const express = require("express");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/db");
const storage = require("../../lib/storage");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { upload } = require("./_shared");
const { colLetter, getCellText } = require("../../lib/excel/cellUtils");
const { SYSTEM_FIELDS } = require("../../lib/excel/systemContext");

const router = express.Router();
router.use(auth);

// ── Helpers (tags + M:N school link) ─────────────────────────
function parseArrayField(val) {
  if (val == null || val === "") return null;
  if (Array.isArray(val)) return val;
  try { const p = JSON.parse(val); return Array.isArray(p) ? p : null; } catch { return null; }
}

async function replaceTemplateSchoolLinks(templateId, schoolIds) {
  const pool = supabase.pool;
  await pool.query(`DELETE FROM excel_template_schools WHERE template_id = $1`, [templateId]);
  if (Array.isArray(schoolIds) && schoolIds.length > 0) {
    const valuesSql = schoolIds.map((_, i) => `($1, $${i + 2})`).join(", ");
    await pool.query(
      `INSERT INTO excel_template_schools (template_id, school_id) VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
      [templateId, ...schoolIds]
    );
  }
}

async function loadTemplateSchoolMap(templateIds) {
  if (!templateIds || templateIds.length === 0) return {};
  const pool = supabase.pool;
  const { rows } = await pool.query(
    `SELECT template_id, school_id FROM excel_template_schools WHERE template_id = ANY($1)`,
    [templateIds]
  );
  const map = {};
  for (const r of rows) { (map[r.template_id] ||= []).push(r.school_id); }
  return map;
}

// ================================================================
// POST /api/excel/upload-template
// Upload .xlsx → parse ALL cells → return for mapping
// ================================================================
router.post("/upload-template", upload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ফাইল আপলোড করুন" });

    const { school_name } = req.body;
    if (!school_name) return res.status(400).json({ error: "স্কুলের নাম দিন" });
    const tags = parseArrayField(req.body.tags) || [];
    const schoolIds = parseArrayField(req.body.school_ids) || [];

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

    // 1. ফাইল storage-এ save করো (local FS বা R2 — STORAGE_BACKEND env দ্বারা নির্ধারিত)
    // DB-তে relative key store হয় (`excel-templates/<filename>`) — absolute path নয়
    // যাতে VPS migrate / backend redeploy / cwd change-এ ভাঙে না।
    const safeName = `${agencyId}_${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._\-]/g, "_")}`;
    const storageKey = `excel-templates/${safeName}`;
    const fileBuffer = fs.readFileSync(req.file.path);
    await storage.put(storageKey, fileBuffer);
    try { fs.unlinkSync(req.file.path); } catch {} // multer temp file মুছি
    console.log("[Excel] Template saved:", storageKey, "via", storage.kind);

    // 2. Parse Excel — শুধু {{placeholder}} cells detect করো (buffer থেকে — local/R2 uniform)
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);

    const placeholders = []; // শুধু {{...}} আছে এমন cells
    const seen = new Set();  // duplicate detect (merged cells একই data repeat করে)
    workbook.eachSheet((sheet) => {
      // Merged cell ranges সংগ্রহ — duplicate skip-এর জন্য
      const mergedMaster = new Set(); // "col:row" of master cells
      const mergedSlave = new Set();  // "col:row" of slave cells (skip these)
      if (sheet.model?.merges) {
        sheet.model.merges.forEach(range => {
          // range = "A7:A8" format
          const parts = range.split(":");
          if (parts.length === 2) {
            // First cell = master, rest = slaves
            mergedMaster.add(parts[0]);
          }
        });
      }

      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const value = getCellText(cell);
          const matches = value.match(/\{\{([^}]+)\}\}/g);
          if (matches) {
            matches.forEach(match => {
              const key = match.replace(/\{\{|\}\}/g, "").trim();
              // Merged cell duplicate: same key + same column = merged cell repeat → প্রথমটাই রাখো
              const uniqueKey = `${sheet.name}::${key}`;
              if (seen.has(uniqueKey)) return;
              seen.add(uniqueKey);

              placeholders.push({
                sheet: sheet.name,
                cell: `${colLetter(colNumber)}${rowNumber}`,
                row: rowNumber,
                col: colNumber,
                placeholder: match,
                key,
                label: key,
                field: key,
                fullCellValue: value,
              });
            });
          }
        });
      });
    });

    // 3. Save template record to DB
    // school_id legacy column: keep first selected school as the "primary" for read paths
    // that haven't been migrated yet (generate.js etc.). Junction is the source of truth.
    const { data: tmpl, error } = await supabase
      .from("excel_templates")
      .insert({
        agency_id: agencyId,
        school_name,
        school_id: schoolIds[0] || null,
        file_name: req.file.originalname,
        template_url: storageKey, // relative key — backend-agnostic (local FS or R2)
        mappings: JSON.stringify(placeholders), // {{}} mappings — JSONB column-এ string হিসেবে পাঠাই
        total_fields: placeholders.length,
        mapped_fields: placeholders.filter(p => p.field).length,
        tags,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

    if (tmpl && schoolIds.length > 0) {
      await replaceTemplateSchoolLinks(tmpl.id, schoolIds);
      tmpl.school_ids = schoolIds;
    } else if (tmpl) {
      tmpl.school_ids = [];
    }

    res.json({
      template: tmpl,
      sheets: workbook.worksheets.map((s) => s.name),
      placeholders,
      totalPlaceholders: placeholders.length,
      storage: "local",
    });
  } catch (err) {
    console.error("Upload template error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// GET /api/excel/templates  — tags + school_ids[] সহ
// ================================================================
router.get("/templates", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("excel_templates")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  const list = data || [];
  const map = await loadTemplateSchoolMap(list.map(t => t.id));
  for (const t of list) {
    t.tags = t.tags || [];
    t.school_ids = map[t.id] || (t.school_id ? [t.school_id] : []);
  }
  res.json(list);
}));

// ================================================================
// PATCH /api/excel/templates/:id  — tags / school_ids / school_name update
// ================================================================
router.patch("/templates/:id", asyncHandler(async (req, res) => {
  const updates = { updated_at: new Date().toISOString() };
  if (req.body.school_name !== undefined) updates.school_name = req.body.school_name;
  const tags = parseArrayField(req.body.tags);
  if (tags !== null) updates.tags = tags;
  const schoolIds = parseArrayField(req.body.school_ids);
  if (schoolIds !== null) {
    updates.school_id = schoolIds[0] || null; // keep legacy column in sync
  }

  const { data, error } = await supabase
    .from("excel_templates")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: "Update ব্যর্থ" });

  if (data && schoolIds !== null) {
    await replaceTemplateSchoolLinks(data.id, schoolIds);
    data.school_ids = schoolIds;
  } else if (data) {
    const map = await loadTemplateSchoolMap([data.id]);
    data.school_ids = map[data.id] || (data.school_id ? [data.school_id] : []);
  }
  res.json(data);
}));

// ================================================================
// GET /api/excel/templates/:id
// ================================================================
router.get("/templates/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("excel_templates")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (error) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
  res.json(data);
}));

// ================================================================
// POST /api/excel/templates/:id/mapping
// Body: { mappings: [{ cell: "B3", label: "名前", field: "name_en", targetCell: "B3" }, ...] }
// ================================================================
router.post("/templates/:id/mapping", asyncHandler(async (req, res) => {
  console.error("[MAPPING DEBUG] body:", JSON.stringify(req.body).slice(0, 300), "type:", typeof req.body.mappings, "isArray:", Array.isArray(req.body.mappings));
  const { mappings } = req.body;
  if (!mappings) return res.status(400).json({ error: "mappings field নেই", received: Object.keys(req.body) });
  const arr = Array.isArray(mappings) ? mappings : (typeof mappings === "string" ? JSON.parse(mappings) : []);
  if (!arr.length) return res.status(400).json({ error: "mappings খালি" });

  const mapped = arr.filter((m) => m.field && m.field.trim());

  const { data, error } = await supabase
    .from("excel_templates")
    .update({ mappings: JSON.stringify(arr), mapped_fields: mapped.length, total_fields: arr.length })
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// ================================================================
// DELETE /api/excel/templates/:id
// ================================================================
router.delete("/templates/:id", asyncHandler(async (req, res) => {
  const { data: tmpl } = await supabase.from("excel_templates").select("template_url").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (tmpl && tmpl.template_url) {
    try { await storage.del(tmpl.template_url); } catch (e) { console.warn("[Excel] storage delete:", e.message); }
  }
  const { error } = await supabase.from("excel_templates").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

// ================================================================
// GET /api/excel/system-fields
// ================================================================
router.get("/system-fields", (req, res) => res.json(SYSTEM_FIELDS));

module.exports = router;
