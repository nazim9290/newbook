/**
 * pdfTemplates.js — Agency-side PDF template generation. Supports two fill modes:
 *
 *   (A) AcroForm fields  — filled by name (form.getField(name).setText/check/select).
 *   (B) {{placeholder}}  — literal text in the PDF, found via pdfjs-dist scan, then
 *                          covered with a white rectangle and the resolved value drawn on top.
 *
 * Either mode (or both) can be present in the same PDF.
 *
 * Data layer is SHARED with docgen — same flat keys (name_en, sponsor_name, family1_name,
 * dob:year/:month/:day/:jp, ...) so the SAME mapping dropdown/options work everywhere.
 *
 * Resolution per field name (used as map key):
 *   1. If template_data.mappings[name] is set → resolve that mapping via flat data
 *      (mapping value can include modifier suffix, e.g. "name_en:last").
 *   2. Else use the field name itself as the key — works directly for {{name_en}}-style
 *      placeholders, and effectively makes mapping optional when the placeholder text
 *      already matches a system field.
 *
 * GET /api/pdf-templates/available?student_id=X
 *   → list of category=pdf default_templates filtered by stage_visibility matching student status
 *
 * GET /api/pdf-templates/:id/generate?student_id=X
 *   → loads the original PDF, fills AcroForm + replaces placeholders, returns PDF
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { decryptSensitiveFields } = require("../lib/crypto");
const { scanPdfPlaceholders } = require("../lib/pdfPlaceholders");
const { flattenForDoc, mergeDocData } = require("../lib/docgen/studentFlatten");
const { resolveValue } = require("../lib/docgen/valueResolver");

const router = express.Router();
router.use(auth);

// Truthy → check; falsy → uncheck
function isTruthy(v) {
  if (!v) return false;
  const s = String(v).toLowerCase().trim();
  return !["0", "false", "no", "n", ""].includes(s);
}

// ════════════════════════════════════════════════════════════
// GET /api/pdf-templates/available?student_id=X
// ════════════════════════════════════════════════════════════
router.get("/available", asyncHandler(async (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: "student_id দিন" });

  const { data: st } = await supabase.from("students").select("status")
    .eq("id", student_id).eq("agency_id", req.user.agency_id).single();
  if (!st) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const { data: templates } = await supabase.from("default_templates")
    .select("id, name, name_bn, description, sub_category, country, file_name, template_data, sort_order")
    .eq("category", "pdf").eq("is_active", true).order("sort_order");

  const filtered = (templates || []).filter(t => {
    const td = typeof t.template_data === "string" ? JSON.parse(t.template_data) : (t.template_data || {});
    const stages = td.stage_visibility || [];
    return stages.length === 0 || stages.includes(st.status);
  });

  res.json(filtered);
}));

// ════════════════════════════════════════════════════════════
// GET /api/pdf-templates/:id/generate?student_id=X
// ════════════════════════════════════════════════════════════
router.get("/:id/generate", asyncHandler(async (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: "student_id দিন" });

  const { data: tpl, error } = await supabase.from("default_templates")
    .select("*").eq("id", req.params.id).eq("category", "pdf").single();
  if (error || !tpl) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
  const td = typeof tpl.template_data === "string" ? JSON.parse(tpl.template_data) : (tpl.template_data || {});
  const mappings = td.mappings || {};

  // Read original fillable PDF
  if (!tpl.file_url) return res.status(400).json({ error: "Template ফাইল নেই" });
  const pdfPath = path.join(__dirname, "../..", tpl.file_url);
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: "Template ফাইল disk-এ নেই" });

  // Fetch student + related — same query set as docgen/generate.js so flattenForDoc has everything
  const { data: student } = await supabase.from("students").select("*")
    .eq("id", student_id).eq("agency_id", req.user.agency_id).single();
  if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const [eduRes, examRes, famRes, sponsorRes, workRes, jpStudyRes,
         agencyRes, schoolRes, batchRes, branchRes, docDataRes] = await Promise.all([
    supabase.from("student_education").select("*").eq("student_id", student_id),
    supabase.from("student_jp_exams").select("*").eq("student_id", student_id),
    supabase.from("student_family").select("*").eq("student_id", student_id),
    supabase.from("sponsors").select("*").eq("student_id", student_id),
    supabase.from("student_work_experience").select("*").eq("student_id", student_id),
    supabase.from("student_jp_study").select("*").eq("student_id", student_id),
    supabase.from("agencies").select("*").eq("id", req.user.agency_id).single(),
    student.school_id
      ? supabase.from("schools").select("*").eq("id", student.school_id).single()
      : (student.school
          ? supabase.from("schools").select("*").eq("agency_id", req.user.agency_id).eq("name_en", student.school).limit(1)
          : Promise.resolve({ data: null })),
    student.batch_id ? supabase.from("batches").select("*").eq("id", student.batch_id).single() : Promise.resolve({ data: null }),
    student.branch ? supabase.from("branches").select("*").eq("agency_id", req.user.agency_id).eq("name", student.branch).single() : Promise.resolve({ data: null }),
    supabase.from("document_data").select("doc_type_id, field_data, doc_types(name)").eq("student_id", student_id).eq("agency_id", req.user.agency_id),
  ]);
  student.student_education  = eduRes.data || [];
  student.student_jp_exams   = examRes.data || [];
  student.student_family     = famRes.data || [];
  student.sponsors           = sponsorRes.data || [];
  student.work_experience    = workRes.data || [];
  student.jp_study           = jpStudyRes.data || [];

  const decrypted = decryptSensitiveFields(student);
  const agency = agencyRes.data || {};
  const school = Array.isArray(schoolRes.data) ? (schoolRes.data[0] || {}) : (schoolRes.data || {});
  const batch  = batchRes.data  || {};
  const branch = branchRes.data || {};

  // Build flat data the SAME way docgen does — keys: name_en, sponsor_name, family1_name, dob, ...
  const flat = { ...flattenForDoc(decrypted, { agency, school, batch, branch }) };
  mergeDocData(flat, docDataRes.data || []);

  // Load PDF + fill form
  const pdfBytes = fs.readFileSync(pdfPath);
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (err) {
    console.error("[PDF Template] Load failed:", err.message);
    return res.status(500).json({ error: "PDF load করতে সমস্যা" });
  }

  // Resolve a field/placeholder name:
  //   1. Explicit mapping  → "name_en:last", "sponsor_name", etc. → resolve via flat
  //   2. Else use the name itself as the key (works for {{name_en}}-style placeholders)
  // Returns null if the resolved value is empty (so caller can decide to skip vs blank).
  const resolveByName = (name) => {
    if (!name) return null;
    const mappedKey = mappings[name];
    const lookup = mappedKey || name;
    const v = resolveValue(flat, lookup);
    return (v === undefined || v === null || v === "") ? null : String(v);
  };

  // ── (A) Fill AcroForm fields ─────────────────────────────────
  // For each field we resolve in this priority:
  //   1. Field's CURRENT VALUE = "{{key}}" → admin typed an inline placeholder; resolve `key`
  //   2. Explicit mapping by field name → resolve mapping
  //   3. Field name itself matches a system field (rare for cryptic XFA names)
  const form = pdfDoc.getForm();
  const acroFields = form.getFields();
  for (const field of acroFields) {
    const fieldName = field.getName();
    const typ = field.constructor.name;

    // Read current value to detect inline {{...}} placeholder
    let currentValue = "";
    try {
      if (typ === "PDFTextField")        currentValue = field.getText() || "";
      else if (typ === "PDFDropdown")    currentValue = (field.getSelected() || [])[0] || "";
    } catch {}
    const inlineMatch = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(currentValue);
    let value;
    if (inlineMatch) {
      const key = inlineMatch[1].trim();
      // Mapping under the placeholder key takes priority over direct lookup
      const mappedKey = mappings[key] || mappings[fieldName];
      const lookup = mappedKey || key;
      const v = resolveValue(flat, lookup);
      value = (v === undefined || v === null || v === "") ? null : String(v);
    } else {
      value = resolveByName(fieldName);
    }
    if (value === null) continue;
    try {
      if (typ === "PDFTextField") {
        field.setText(value || "");
      } else if (typ === "PDFCheckBox") {
        if (isTruthy(value)) field.check(); else field.uncheck();
      } else if (typ === "PDFDropdown" || typ === "PDFOptionList") {
        if (value) field.select(value);
      } else if (typ === "PDFRadioGroup") {
        if (value) { try { field.select(value); } catch { /* option not found */ } }
      }
    } catch (err) {
      console.error(`[PDF fill] AcroForm "${fieldName}" type=${typ} value="${value}" — ${err.message}`);
    }
  }

  // ── (B) Replace {{placeholder}} text ─────────────────────────
  let placeholders = [];
  try {
    placeholders = await scanPdfPlaceholders(pdfBytes);
  } catch (err) {
    console.error("[PDF Generate] Placeholder scan failed:", err.message);
  }

  if (placeholders.length > 0) {
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    for (const ph of placeholders) {
      const page = pages[ph.page - 1];
      if (!page) continue;
      const value = resolveByName(ph.key);
      if (value === null) continue;       // unmapped → leave {{key}} visible (admin sees what's missing)

      // Cover the original {{key}} text with a white rectangle slightly bigger than the glyph box
      const padX = 1, padY = 2;
      page.drawRectangle({
        x: ph.x - padX,
        y: ph.y - padY,
        width: (ph.width || 0) + padX * 2,
        height: (ph.fontSize || 11) + padY * 2,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });

      // Draw replacement value at the same baseline
      if (value) {
        page.drawText(String(value), {
          x: ph.x,
          y: ph.y,
          size: ph.fontSize || 11,
          font: helv,
          color: rgb(0, 0, 0),
        });
      }
    }
  }

  // Flatten optional — keep editable for now so user can adjust
  // form.flatten();

  const filledBytes = await pdfDoc.save();

  const safeName = (student.name_en || student_id).replace(/[^A-Za-z0-9_-]+/g, "_");
  const tplSlug = (tpl.name || "Template").replace(/[^A-Za-z0-9_-]+/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${tplSlug}_${safeName}.pdf"`);
  res.send(Buffer.from(filledBytes));
}));

module.exports = router;
