const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// Filename sanitization — path traversal ও special char সরাও
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

// File upload config — sanitized filename
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../uploads"),
  filename: (req, file, cb) => cb(null, `template_${Date.now()}_${sanitize(file.originalname)}`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) cb(null, true);
    else cb(new Error("শুধু .xlsx বা .xls ফাইল আপলোড করুন"));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ================================================================
// POST /api/excel/upload-template
// Upload .xlsx → parse ALL cells → return for mapping
// ================================================================
router.post("/upload-template", upload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ফাইল আপলোড করুন" });

    const { school_name } = req.body;
    if (!school_name) return res.status(400).json({ error: "স্কুলের নাম দিন" });

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

    // 1. Local VPS-এ ফাইল রাখি — permanent path-এ move
    const permanentDir = path.join(__dirname, "../../uploads/excel-templates");
    if (!fs.existsSync(permanentDir)) fs.mkdirSync(permanentDir, { recursive: true });
    const safeName = `${agencyId}_${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._\-]/g, "_")}`;
    const permanentPath = path.join(permanentDir, safeName);
    fs.copyFileSync(req.file.path, permanentPath);
    try { fs.unlinkSync(req.file.path); } catch {} // temp file মুছি
    console.log("Template saved locally:", permanentPath);

    // 2. Parse Excel — শুধু {{placeholder}} cells detect করো
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(permanentPath);

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
    const { data: tmpl, error } = await supabase
      .from("excel_templates")
      .insert({
        agency_id: agencyId,
        school_name,
        file_name: req.file.originalname,
        template_url: permanentPath, // VPS local path — getTemplateBuffer এখান থেকে পড়বে
        mappings: JSON.stringify(placeholders), // {{}} mappings — JSONB column-এ string হিসেবে পাঠাই
        total_fields: placeholders.length,
        mapped_fields: placeholders.filter(p => p.field).length,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

    // 4. File already moved to permanent path — nothing to clean
    if (false) {
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
// GET /api/excel/templates
// ================================================================
router.get("/templates", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("excel_templates")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
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
// POST /api/excel/generate
// Body: { template_id, student_ids: ["S-001", ...] }
// Returns: .xlsx file (exact copy of template with data filled)
// ================================================================
router.post("/generate", asyncHandler(async (req, res) => {
  try {
    const { template_id, student_ids } = req.body;
    if (!template_id) return res.status(400).json({ error: "template_id দিন" });
    if (!student_ids || !student_ids.length) return res.status(400).json({ error: "student_ids দিন" });

    // Get template
    const { data: tmpl, error: tErr } = await supabase
      .from("excel_templates")
      .select("*")
      .eq("id", template_id)
      .eq("agency_id", req.user.agency_id)
      .single();
    if (tErr) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
    if (!tmpl.mappings || !tmpl.mappings.length) return res.status(400).json({ error: "কোনো mapping নেই" });

    // Get students — try JOIN, fallback to separate queries
    let students = [];
    try {
      const { data, error: sErr } = await supabase
        .from("students")
        .select("*, student_education(*), student_jp_exams(*), student_family(*), sponsors!sponsors_student_id_fkey(*)")
        .in("id", student_ids)
        .eq("agency_id", req.user.agency_id);
      if (sErr) throw sErr;
      students = data || [];
    } catch (joinErr) {
      console.log("[Excel Generate Bulk] JOIN failed, using separate queries:", joinErr.message);
      const { data: sts } = await supabase.from("students").select("*").in("id", student_ids).eq("agency_id", req.user.agency_id);
      if (!sts) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
      students = await Promise.all(sts.map(async (st) => {
        const [eduRes, jpRes, famRes, spRes, workRes, jpStudyRes] = await Promise.all([
          supabase.from("student_education").select("*").eq("student_id", st.id),
          supabase.from("student_jp_exams").select("*").eq("student_id", st.id),
          supabase.from("student_family").select("*").eq("student_id", st.id),
          supabase.from("sponsors").select("*").eq("student_id", st.id),
          supabase.from("student_work_experience").select("*").eq("student_id", st.id),
          supabase.from("student_jp_study").select("*").eq("student_id", st.id),
        ]);
        return { ...st, student_education: eduRes.data || [], student_jp_exams: jpRes.data || [], student_family: famRes.data || [], sponsors: spRes.data || [], work_experience: workRes.data || [], jp_study: jpStudyRes.data || [] };
      }));
    }

    // Template file: Supabase storage থেকে download
    const templateBuffer = await getTemplateBuffer(tmpl.template_url);
    if (!templateBuffer) {
      return generateCSV(res, tmpl, students);
    }

    if (students.length === 1) {
      const buffer = await fillSingleStudentFromBuffer(templateBuffer, tmpl.mappings, students[0]);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(students[0].name_en || students[0].id)}.xlsx"`);
      res.send(buffer);
    } else {
      // Multiple students: each gets their own COMPLETE copy of the template
      // Output: one .xlsx per student, but we pack them as separate files
      // For simplicity: generate first student as primary download
      // Better approach: generate each separately with fillSingleStudent
      const buffer = await fillSingleStudentFromBuffer(templateBuffer, tmpl.mappings, students[0]);

      // For bulk: return a zip or let frontend call one-by-one
      // Here we return first student + metadata for others
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(students[0].name_en || students[0].id)}.xlsx"`);
      res.setHeader("X-Total-Students", students.length);
      res.setHeader("X-Generated-For", students[0].name_en || students[0].id);
      res.send(buffer);
    }
  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/excel/generate-single
// Body: { template_id, student_id }
// For bulk: frontend calls this once per student
// ================================================================
router.post("/generate-single", asyncHandler(async (req, res) => {
  try {
    const { template_id, student_id } = req.body;
    if (!template_id || !student_id) return res.status(400).json({ error: "template_id ও student_id দিন" });

    const { data: tmpl } = await supabase.from("excel_templates").select("*").eq("id", template_id).single();
    if (!tmpl) return res.status(404).json({ error: "Template পাওয়া যায়নি" });

    // Student + related data load — try JOIN, fallback to separate queries
    let student = null;
    try {
      const { data, error } = await supabase
        .from("students")
        .select("*, student_education(*), student_jp_exams(*), student_family(*), sponsors!sponsors_student_id_fkey(*)")
        .eq("id", student_id)
        .eq("agency_id", req.user.agency_id)
        .single();
      if (error) throw error;
      student = data;
    } catch (joinErr) {
      // JOIN fail — separate queries
      console.log("[Excel Generate] JOIN failed, using separate queries:", joinErr.message);
      const { data: st } = await supabase.from("students").select("*").eq("id", student_id).eq("agency_id", req.user.agency_id).single();
      if (!st) return res.status(404).json({ error: "Student পাওয়া যায়নি" });
      const [eduRes, jpRes, famRes, spRes, workRes, jpStudyRes] = await Promise.all([
        supabase.from("student_education").select("*").eq("student_id", student_id),
        supabase.from("student_jp_exams").select("*").eq("student_id", student_id),
        supabase.from("student_family").select("*").eq("student_id", student_id),
        supabase.from("sponsors").select("*").eq("student_id", student_id),
        supabase.from("student_work_experience").select("*").eq("student_id", student_id),
        supabase.from("student_jp_study").select("*").eq("student_id", student_id),
      ]);
      student = { ...st, student_education: eduRes.data || [], student_jp_exams: jpRes.data || [], student_family: famRes.data || [], sponsors: spRes.data || [], work_experience: workRes.data || [], jp_study: jpStudyRes.data || [] };
    }
    if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

    // ── সিস্টেম ভ্যারিয়েবল: এজেন্সি, ব্যাচ, ব্রাঞ্চ, স্কুল fetch ──
    // School: student-এর school_id → fallback template-এর school_id
    const schoolId = student.school_id || tmpl.school_id;
    const [agencyRes, batchRes, branchRes, schoolRes] = await Promise.all([
      supabase.from("agencies").select("*").eq("id", req.user.agency_id).single(),
      student.batch_id
        ? supabase.from("batches").select("*").eq("id", student.batch_id).single()
        : student.batch
          ? supabase.from("batches").select("*").eq("agency_id", req.user.agency_id).ilike("name", `%${student.batch}%`).limit(1).single()
          : { data: null },
      student.branch ? supabase.from("branches").select("*").eq("agency_id", req.user.agency_id).eq("name", student.branch).single() : { data: null },
      schoolId ? supabase.from("schools").select("*").eq("id", schoolId).single() : { data: null },
    ]);
    const sysContext = buildSystemContext(agencyRes.data, batchRes.data, branchRes.data, schoolRes.data);

    // Template file: storage থেকে download, অথবা local path
    console.log("[Excel Generate] template_url:", tmpl.template_url, "| file_name:", tmpl.file_name);
    const templateBuffer = await getTemplateBuffer(tmpl.template_url);
    if (!templateBuffer) {
      console.error("[Excel Generate] Template file not found, falling back to CSV");
      return generateCSV(res, tmpl, [student]);
    }

    const buffer = await fillSingleStudentFromBuffer(templateBuffer, tmpl.mappings, student, sysContext);
    if (!buffer) {
      // .xls format বা corrupted — CSV fallback
      return generateCSV(res, tmpl, [student]);
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(student.name_en || student.id)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error("Generate single error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/excel/re-parse/:id
// ================================================================
router.post("/re-parse/:id", asyncHandler(async (req, res) => {
  try {
    const { data: tmpl, error } = await supabase
      .from("excel_templates")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
    const templateBuffer = await getTemplateBuffer(tmpl.template_url);
    if (!templateBuffer) {
      return res.status(400).json({ error: "Template ফাইল পাওয়া যায়নি" });
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(templateBuffer);
    } catch {
      const tmpPath = path.join(__dirname, "../../uploads", `tmp_reparse_${Date.now()}.xls`);
      fs.writeFileSync(tmpPath, templateBuffer);
      await workbook.xlsx.readFile(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
    }

    const allCells = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const value = getCellText(cell);
          if (value) {
            allCells.push({ sheet: sheet.name, cell: `${colLetter(colNumber)}${rowNumber}`, row: rowNumber, col: colNumber, label: value });
          }
        });
      });
    });

    const mappingSuggestions = detectMappings(allCells, workbook);
    res.json({ template: tmpl, allCells, mappingSuggestions, existingMappings: tmpl.mappings || [] });
  } catch (err) {
    console.error("Re-parse error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// DELETE /api/excel/templates/:id
// ================================================================
router.delete("/templates/:id", asyncHandler(async (req, res) => {
  const { data: tmpl } = await supabase.from("excel_templates").select("template_url").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (tmpl && tmpl.template_url) {
    // Delete from local
    if (fs.existsSync(tmpl.template_url)) fs.unlinkSync(tmpl.template_url);
    // Delete from Supabase Storage
    await supabase.storage.from("templates").remove([tmpl.template_url]);
  }
  const { error } = await supabase.from("excel_templates").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

// ================================================================
// GET /api/excel/system-fields
// ================================================================
router.get("/system-fields", (req, res) => res.json(SYSTEM_FIELDS));

// ================================================================
// HELPERS
// ================================================================

// Template file আনো — Supabase storage থেকে download অথবা local path থেকে read
async function getTemplateBuffer(templateUrl) {
  if (!templateUrl) return null;

  // 1. Absolute path (VPS local) — সরাসরি read
  if (fs.existsSync(templateUrl)) {
    return fs.readFileSync(templateUrl);
  }

  // 2. uploads/excel-templates/ folder-এ filename দিয়ে চেক
  const uploadsPath = path.join(__dirname, "../../uploads/excel-templates", path.basename(templateUrl));
  if (fs.existsSync(uploadsPath)) {
    return fs.readFileSync(uploadsPath);
  }

  // 3. Backend root-এর relative path
  const relPath = path.join(__dirname, "../..", templateUrl);
  if (fs.existsSync(relPath)) {
    return fs.readFileSync(relPath);
  }

  console.error("Template file not found:", templateUrl);
  return null;
}

// Buffer থেকে template পড়ে student data + system context fill করে return
async function fillSingleStudentFromBuffer(templateBuffer, mappings, student, sysContext = {}) {
  const workbook = new ExcelJS.Workbook();
  // .xlsx.load(buffer) try করো, fail হলে temp file-এ write করে readFile ব্যবহার
  try {
    await workbook.xlsx.load(templateBuffer);
  } catch {
    try {
      // .xls format — temp file-এ write করে readFile দিয়ে পড়ো
      const tmpPath = path.join(__dirname, "../../uploads", `tmp_${Date.now()}.xls`);
      fs.writeFileSync(tmpPath, templateBuffer);
      await workbook.xlsx.readFile(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch {}
    } catch {
      return null; // পড়া যায়নি — CSV fallback
    }
  }

  // Flatten student data + system context merge
  const flat = { ...flattenStudent(student), ...sysContext };

  // Debug — কোন keys আছে log করো
  const availableKeys = Object.keys(flat).filter(k => flat[k]);
  console.log(`[Excel Generate] Student: ${student.name_en || student.id}, available keys: ${availableKeys.length}, sample:`, availableKeys.slice(0, 30).join(", "));
  // Debug — raw student object-এ কোন fields আছে
  console.log(`[Excel Raw Student] birth_place="${student.birth_place}", occupation="${student.occupation}", spouse_name="${student.spouse_name}", edu count=${(student.student_education || []).length}, sponsor count=${(student.sponsors || []).length}`);
  // Debug — flat-এ কোন fields আছে
  console.log(`[Excel Flat] birth_place="${flat.birth_place}", edu_elementary_school="${flat.edu_elementary_school}", sponsor_name="${flat.sponsor_name}", reason="${String(flat.reason_for_study || "").slice(0,30)}"`);

  // সব sheet-এর সব cell scan করো — {{...}} থাকলে replace করো
  // includeEmpty: true — merged cell-এর master cell empty হলেও scan করবে
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const text = getCellText(cell);
        if (text && text.includes("{{")) {
          // সব {{key}} replace করো — sub-field support (:year, :month, :day, :first, :last)
          let hasMissing = false;
          const replaced = text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const k = key.trim();
            const mapping = mappings.find(m => m.key === k || m.placeholder === match);
            const fieldKey = mapping?.field || k;
            let val = resolveFieldValue(flat, fieldKey);

            // Encrypted hash detect — decrypt fail হলে empty করো
            if (looksEncrypted(val)) {
              try {
                const { decrypt } = require("../lib/crypto");
                const decVal = decrypt(val);
                val = (decVal && !looksEncrypted(decVal)) ? decVal : "";
              } catch { val = ""; }
            }

            // Value না থাকলে placeholder নাম রাখো (পরে লাল করব)
            if (!val && val !== "0") {
              hasMissing = true;
              return `[${k}]`; // e.g. [father_name_en]
            }
            // Date object হলে string-এ convert
            return val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
          });
          cell.value = replaced;

          // Missing value থাকলে font color RED করো
          if (hasMissing) {
            const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
            cell.style = {
              ...oldStyle,
              font: { ...(oldStyle.font || {}), color: { argb: "FFFF0000" } }, // Red color
            };
          }
        }
      });
    });
  });

  return await workbook.xlsx.writeBuffer();
}

// Student object-কে flat key-value-তে convert (nested education, sponsor etc.)
// Encrypted fields auto-decrypt হয়
function flattenStudent(student) {
  const { decryptSensitiveFields } = require("../lib/crypto");
  const decrypted = decryptSensitiveFields(student);
  const flat = { ...decrypted };

  // ── Date fields normalize — pg driver Date object কে "YYYY-MM-DD" string-এ convert ──
  for (const key of Object.keys(flat)) {
    if (flat[key] instanceof Date) {
      flat[key] = flat[key].toISOString().slice(0, 10);
    }
  }

  // ── Field alias mapping — DB column name → Excel placeholder key ──
  // DB-তে father_name/father_en/mother_name/mother_en আছে, Excel-এ father_name_en/mother_name_en ব্যবহার হয়
  flat.father_name_en = flat.father_name_en || flat.father_en || flat.father_name || "";
  flat.mother_name_en = flat.mother_name_en || flat.mother_en || flat.mother_name || "";
  flat.father_name = flat.father_name || flat.father_name_en || "";
  flat.mother_name = flat.mother_name || flat.mother_name_en || "";
  flat.passport_number = flat.passport_number || flat.passport || "";
  flat.permanent_address = flat.permanent_address || flat.present_address || "";
  flat.current_address = flat.current_address || flat.present_address || flat.permanent_address || "";
  flat.birth_place = flat.birth_place || "";
  flat.occupation = flat.occupation || "";
  flat.marital_status = flat.marital_status || "";
  flat.nationality = flat.nationality || "Bangladeshi";
  flat.blood_group = flat.blood_group || "";
  flat.name_katakana = flat.name_katakana || "";

  // Study plan fields — DB-তে students table-এ সরাসরি আছে
  flat.reason_for_study = flat.reason_for_study || student.reason_for_study || "";
  flat.future_plan = flat.future_plan || student.future_plan || "";
  flat.study_subject = flat.study_subject || student.study_subject || "";

  // Additional personal fields
  flat.birth_place = flat.birth_place || student.birth_place || "";
  flat.occupation = flat.occupation || student.occupation || "";
  flat.spouse_name = flat.spouse_name || student.spouse_name || "";
  flat.emergency_contact = flat.emergency_contact || student.emergency_contact || "";
  flat.emergency_phone = flat.emergency_phone || student.emergency_phone || "";

  // Education: SSC, HSC, Honours
  const edu = student.student_education || student.education || [];
  const ssc = edu.find(e => (e.level || "").toLowerCase().includes("ssc")) || {};
  const hsc = edu.find(e => (e.level || "").toLowerCase().includes("hsc")) || {};
  const honours = edu.find(e => (e.level || "").toLowerCase().includes("hon") || (e.level || "").toLowerCase().includes("bach")) || {};
  flat.edu_ssc_school = ssc.school_name || ""; flat.edu_ssc_year = ssc.passing_year || ssc.year || ""; flat.edu_ssc_board = ssc.board || ""; flat.edu_ssc_gpa = ssc.gpa || ""; flat.edu_ssc_subject = ssc.subject_group || ssc.group_name || "";
  flat.edu_ssc_address = ssc.address || "";
  flat.edu_ssc_entrance = ssc.entrance_year || "";
  flat.edu_hsc_school = hsc.school_name || ""; flat.edu_hsc_year = hsc.passing_year || hsc.year || ""; flat.edu_hsc_board = hsc.board || ""; flat.edu_hsc_gpa = hsc.gpa || ""; flat.edu_hsc_subject = hsc.subject_group || hsc.group_name || "";
  flat.edu_hsc_address = hsc.address || "";
  flat.edu_hsc_entrance = hsc.entrance_year || "";
  flat.edu_honours_school = honours.school_name || ""; flat.edu_honours_year = honours.passing_year || honours.year || ""; flat.edu_honours_gpa = honours.gpa || ""; flat.edu_honours_subject = honours.subject_group || honours.group_name || "";
  flat.edu_honours_address = honours.address || "";
  flat.edu_honours_entrance = honours.entrance_year || "";

  // ── Japanese form education — বাংলাদেশ শিক্ষা ব্যবস্থা mapping ──
  // Elementary (小学校) = প্রাথমিক (১-৫ শ্রেণী)
  // Junior High (中学校) = জুনিয়র/SSC (৬-১০ শ্রেণী) — SSC ডিগ্রি
  // High School (高等学校) = উচ্চ মাধ্যমিক/HSC (১১-১২) — HSC ডিগ্রি
  // Technical (専門学校) = টেকনিক্যাল/Diploma (SSC পরবর্তী)
  // University (大学) = বিশ্ববিদ্যালয়/Honours
  const elementary = edu.find(e => /elementary|primary|psc|小学/i.test(e.level || "") || /elementary/i.test(e.school_type || "")) || {};
  const junior = edu.find(e => /^ssc$|junior.*high|jsc|中学/i.test(e.level || "") || /junior/i.test(e.school_type || "")) || {};
  const highSchool = edu.find(e => /^hsc$|^high|alim|diploma.*hsc|高等/i.test(e.level || "") || /^high/i.test(e.school_type || "")) || {};
  const technical = edu.find(e => /technical|diploma|polytechnic|専門/i.test(e.level || "") || /technical/i.test(e.school_type || "")) || {};
  const juniorCollege = edu.find(e => /junior.*college|短期/i.test(e.level || "") || /junior.*college/i.test(e.school_type || "")) || {};
  const university = edu.find(e => /university|honours|hon|bach|degree|大学/i.test(e.level || "") || /university/i.test(e.school_type || "")) || {};

  // Each level: school, address, entrance_year/month, graduation_year/month, years (在学年数)
  const eduMap = { elementary, junior, highSchool: highSchool, technical, juniorCollege, university };
  for (const [prefix, e] of Object.entries(eduMap)) {
    const p = `edu_${prefix}`;
    flat[`${p}_school`] = e.school_name || "";
    flat[`${p}_address`] = e.address || "";
    flat[`${p}_entrance`] = e.entrance_year || "";
    flat[`${p}_entrance_month`] = e.entrance_month || "";
    // graduation/passing year — DB-তে "year" column-এ "2015-12" format থাকে
    flat[`${p}_graduation`] = e.passing_year || e.graduation_year || e.year || "";
    flat[`${p}_graduation_month`] = e.graduation_month || e.passing_month || "";
    // 在学年数 (years of study) — entrance から graduation まで
    const gradYear = e.passing_year || e.graduation_year || e.year || "";
    if (e.entrance_year && gradYear) {
      flat[`${p}_years`] = String(parseInt(gradYear) - parseInt(e.entrance_year));
    } else {
      flat[`${p}_years`] = "";
    }
  }

  // JP Exams
  const jp = (student.student_jp_exams || [])[0] || {};
  flat.jp_exam_type = jp.exam_type || ""; flat.jp_level = jp.level || ""; flat.jp_score = jp.score || ""; flat.jp_result = jp.result || ""; flat.jp_exam_date = jp.exam_date || "";

  // Sponsor
  const spRaw = (student.sponsors || [])[0] || student.sponsor || {};
  const sp = decryptSensitiveFields(spRaw);
  flat.sponsor_name = sp.name || ""; flat.sponsor_name_en = sp.name_en || sp.name || "";
  flat.sponsor_relationship = sp.relationship || ""; flat.sponsor_phone = sp.phone || "";
  flat.sponsor_address = sp.permanent_address || sp.present_address || sp.address || "";
  flat.sponsor_present_address = sp.present_address || sp.address || "";
  flat.sponsor_permanent_address = sp.permanent_address || sp.address || "";
  flat.sponsor_company = sp.company_name || "";
  flat.sponsor_company_name = sp.company_name || "";
  flat.sponsor_company_phone = sp.company_phone || "";
  flat.sponsor_company_address = sp.company_address || "";
  flat.sponsor_trade_license = sp.trade_license || sp.trade_license_no || "";
  flat.sponsor_work_address = sp.work_address || "";
  // Sponsor parents
  flat.sponsor_father_name = sp.father_name || "";
  flat.sponsor_mother_name = sp.mother_name || "";
  // Tax/Income
  flat.sponsor_dob = sp.dob || "";
  flat.sponsor_nid = sp.nid || "";
  flat.sponsor_tin = sp.tin || "";
  flat.sponsor_income_year_1 = sp.income_year_1 || "";
  flat.sponsor_income_year_2 = sp.income_year_2 || "";
  flat.sponsor_income_year_3 = sp.income_year_3 || "";
  flat.sponsor_income_source_1 = sp.income_source_1 || "";
  flat.sponsor_income_source_2 = sp.income_source_2 || "";
  flat.sponsor_income_source_3 = sp.income_source_3 || "";
  flat.sponsor_income_y1 = sp.annual_income_y1 || ""; flat.sponsor_income_y2 = sp.annual_income_y2 || ""; flat.sponsor_income_y3 = sp.annual_income_y3 || "";
  flat.sponsor_income = sp.annual_income_y1 || "";
  flat.sponsor_tax_y1 = sp.tax_y1 || ""; flat.sponsor_tax_y2 = sp.tax_y2 || ""; flat.sponsor_tax_y3 = sp.tax_y3 || "";
  flat.sponsor_statement = sp.statement || "";

  // Family
  const fam = student.student_family || [];
  const father = fam.find(f => f.relation === "father") || {};
  const mother = fam.find(f => f.relation === "mother") || {};
  // Father/Mother — student_family table fallback → students table direct fields
  flat.father_dob = father.dob || flat.father_dob || student.father_dob || "";
  flat.father_occupation = father.occupation || flat.father_occupation || student.father_occupation || "";
  flat.father_phone = father.phone || flat.father_phone || "";
  flat.mother_dob = mother.dob || flat.mother_dob || student.mother_dob || "";
  flat.mother_occupation = mother.occupation || flat.mother_occupation || student.mother_occupation || "";
  flat.mother_phone = mother.phone || flat.mother_phone || "";

  // Family detailed (family1, family2, family3)
  fam.forEach((f, i) => {
    const idx = i + 1;
    flat[`family${idx}_name`] = f.name || "";
    flat[`family${idx}_relation`] = f.relation || "";
    flat[`family${idx}_dob`] = f.dob || "";
    flat[`family${idx}_occupation`] = f.occupation || "";
    flat[`family${idx}_address`] = f.address || "";
  });

  // Age from DOB
  if (flat.dob) {
    const age = Math.floor((Date.now() - new Date(flat.dob)) / (365.25 * 24 * 60 * 60 * 1000));
    flat.age = String(age);
  }

  // ── JP Study History — agency+batch fallback (docgen.js-এর মতো) ──
  const jpStudyAll = student.jp_study || [];
  const jpStudy = jpStudyAll[0] || {};
  flat.jp_study_institution = jpStudy.institution || flat.sys_agency_name || "";
  flat.jp_study_address = jpStudy.address || flat.sys_agency_address || "";
  flat.jp_study_from = jpStudy.period_from || flat.sys_batch_start || "";
  flat.jp_study_to = jpStudy.period_to || flat.sys_batch_end || "";
  flat.jp_study_hours = jpStudy.total_hours || flat.sys_batch_hours || "";

  // ── Work Experience — 職歴 ──
  const workAll = student.work_experience || [];
  workAll.forEach((w, i) => {
    const idx = i + 1;
    flat[`work${idx}_company`] = w.company_name || "";
    flat[`work${idx}_address`] = w.address || "";
    flat[`work${idx}_position`] = w.position || "";
    flat[`work${idx}_start`] = w.start_date || "";
    flat[`work${idx}_end`] = w.end_date || "";
  });
  // Shorthand — first entry
  const work = workAll[0] || {};
  flat.work_company = work.company_name || "";
  flat.work_address = work.address || "";
  flat.work_position = work.position || "";
  flat.work_start = work.start_date || "";
  flat.work_end = work.end_date || "";

  return flat;
}

/**
 * buildSystemContext — এজেন্সি, ব্যাচ, ব্রাঞ্চ, স্কুলের তথ্য flat key-value-তে
 * sys_* prefix দিয়ে রাখে — Excel template-এ {{sys_agency_name}} দিলে কাজ করবে
 */
function buildSystemContext(agency, batch, branch, school) {
  const ctx = {};
  const today = new Date();

  // ── এজেন্সি ──
  ctx.sys_agency_name = agency?.name || "";
  ctx.sys_agency_name_bn = agency?.name_bn || "";
  ctx.sys_agency_address = agency?.address || "";
  ctx.sys_agency_phone = agency?.phone || "";
  ctx.sys_agency_email = agency?.email || "";

  // ── ব্রাঞ্চ ──
  ctx.sys_branch_name = branch?.name || "";
  ctx.sys_branch_address = branch?.address || branch?.address_bn || "";
  ctx.sys_branch_phone = branch?.phone || "";
  ctx.sys_branch_manager = branch?.manager || "";

  // ── আজকের তারিখ ──
  ctx.sys_today = today.toISOString().slice(0, 10);
  ctx["sys_today:year"] = String(today.getFullYear());
  ctx["sys_today:month"] = String(today.getMonth() + 1).padStart(2, "0");
  ctx["sys_today:day"] = String(today.getDate()).padStart(2, "0");
  // 日本語 format: 2026年03月28日
  ctx.sys_today_jp = `${today.getFullYear()}年${String(today.getMonth()+1).padStart(2,"0")}月${String(today.getDate()).padStart(2,"0")}日`;

  // ── ব্যাচ ──
  ctx.sys_batch_name = batch?.name || "";
  ctx.sys_batch_teacher = batch?.teacher || "";
  ctx.sys_batch_schedule = batch?.schedule || "";
  const bStart = batch?.start_date || "";
  const bEnd = batch?.end_date || "";
  ctx.sys_batch_start = bStart;
  ctx.sys_batch_end = bEnd;
  if (bStart) {
    const d = new Date(bStart);
    ctx["sys_batch_start:year"] = String(d.getFullYear());
    ctx["sys_batch_start:month"] = String(d.getMonth()+1).padStart(2,"0");
    ctx["sys_batch_start:day"] = String(d.getDate()).padStart(2,"0");
  }
  if (bEnd) {
    const d = new Date(bEnd);
    ctx["sys_batch_end:year"] = String(d.getFullYear());
    ctx["sys_batch_end:month"] = String(d.getMonth()+1).padStart(2,"0");
    ctx["sys_batch_end:day"] = String(d.getDate()).padStart(2,"0");
  }

  // ── স্কুল ──
  ctx.sys_school_name = school?.name_en || "";
  ctx.sys_school_name_jp = school?.name_jp || "";
  ctx.sys_school_address = school?.address || "";

  return ctx;
}

/**
 * resolveFieldValue — sub-field support
 * key format: "field_name" বা "field_name:modifier"
 *
 * Date modifiers: :year, :month, :day
 *   dob:year → "1998", dob:month → "03", dob:day → "12"
 *
 * Name modifiers: :first, :last
 *   name_en:first → "Mohammad", name_en:last → "Rahim"
 *   "Mohammad Rahim" → first="Mohammad", last="Rahim"
 */
// Hash/encrypted value detect — "iv:authTag:ciphertext" format (hex:hex:hex)
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  return /^[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/i.test(val);
}

// ── Key alias map — template-এ যেকোনো নাম লিখলে সঠিক flat key-তে resolve হবে ──
const KEY_ALIASES = {
  placeofbirth: "birth_place", place_of_birth: "birth_place",
  st_phone: "phone", telephone: "phone", tel: "phone",
  full_name: "name_en", fullname: "name_en", alphabet: "name_en",
  katakana: "name_katakana",
  sex: "gender",
  birthday: "dob", dateofbirth: "dob", date_of_birth: "dob",
  passport: "passport_number", passport_no: "passport_number",
  address: "permanent_address", registered_address: "permanent_address",
  present_address: "current_address",
  spouse: "spouse_name", spouse_name: "spouse_name",
  father: "father_name_en", father_name: "father_name_en",
  mother: "mother_name_en", mother_name: "mother_name_en",
  father_occupation: "father_occupation", father_dob: "father_dob",
  mother_occupation: "mother_occupation", mother_dob: "mother_dob",
  // Education aliases — AI বিভিন্ন নামে দিতে পারে
  edu_elelementary_name: "edu_elementary_school", edu_elementary_name: "edu_elementary_school",
  edu_elelementary_add: "edu_elementary_address", edu_elementary_add: "edu_elementary_address",
  edu_junior_name: "edu_junior_school", edu_junior_add: "edu_junior_address",
  edu_hsc_add: "edu_hsc_address", edu_hsc_name: "edu_hsc_school",
  edu_technical_name: "edu_technical_school", edu_technical_add: "edu_technical_address",
  edu_university_name: "edu_university_school", edu_university_add: "edu_university_address",
  edu_juniorcollege_name: "edu_juniorCollege_school", edu_juniorcollege_add: "edu_juniorCollege_address",
  // Education — honours aliases
  edu_honours_add: "edu_honours_address",
  // Passport date aliases — template-এ "Passport Issue", "Passport Expiry" ব্যবহার হতে পারে
  "passport issue": "passport_issue", "passport_issue_date": "passport_issue",
  "passport expiry": "passport_expiry", "passport_expiry_date": "passport_expiry",
  // Sponsor
  sponsor: "sponsor_name_en",
  // JP
  jlpt: "jp_level", jlpt_level: "jp_level", jlpt_score: "jp_score",
  // Study
  reason_for_study: "reason_for_study", purpose_of_study: "reason_for_study",
  study_plan: "reason_for_study", future_plan: "future_plan",
  // Work experience aliases
  work_company_name: "work_company", company_name: "work_company",
  work_start_date: "work_start", work_end_date: "work_end",
  // System
  agency_name: "sys_agency_name", agency_address: "sys_agency_address",
  school_name: "sys_school_name", school_name_jp: "sys_school_name_jp",
};

function resolveFieldValue(flat, fieldKey) {
  if (!fieldKey) return "";

  // ── Normalize — double colon ও duplicate modifier fix ──
  // "dob::day:day:day" → "dob:day", "dob:month:month:month" → "dob:month"
  fieldKey = fieldKey.replace(/:+/g, ":").replace(/:$/, "");
  if (fieldKey.includes(":")) {
    const parts = fieldKey.split(":");
    // unique modifier — শেষ valid modifier নাও
    const base = parts[0];
    const mod = parts.find((p, i) => i > 0 && p) || "";
    fieldKey = mod ? `${base}:${mod}` : base;
  }

  // Sub-field check: "dob:year", "name_en:first", etc.
  if (fieldKey.includes(":")) {
    const [baseKey, modifier] = fieldKey.split(":");
    // Base key alias resolve
    const resolvedBase = KEY_ALIASES[baseKey.toLowerCase()] || baseKey;
    let rawValue = flat[resolvedBase] ?? flat[baseKey] ?? "";
    // Case-insensitive fallback
    if (!rawValue) {
      const lk = resolvedBase.toLowerCase();
      for (const [k, v] of Object.entries(flat)) { if (k.toLowerCase() === lk && v) { rawValue = v; break; } }
    }
    if (!rawValue) return "";

    // Date object → ISO string convert
    if (rawValue instanceof Date) rawValue = rawValue.toISOString().slice(0, 10);

    // Date modifiers
    if (["year", "month", "day"].includes(modifier)) {
      // Date format: "1998-03-12" বা "03/12/1998" বা "1998/03/12"
      const dateStr = String(rawValue);
      let y = "", m = "", d = "";

      if (dateStr.includes("-")) {
        // ISO format: 1998-03-12
        const parts = dateStr.split("-");
        y = parts[0] || ""; m = parts[1] || ""; d = parts[2]?.slice(0, 2) || "";
      } else if (dateStr.includes("/")) {
        const parts = dateStr.split("/");
        if (parts[0].length === 4) { y = parts[0]; m = parts[1]; d = parts[2]; } // 1998/03/12
        else { m = parts[0]; d = parts[1]; y = parts[2]; } // 03/12/1998
      }

      if (modifier === "year") return y;
      if (modifier === "month") return m;
      if (modifier === "day") return d;
    }

    // Name modifiers
    if (["first", "last"].includes(modifier)) {
      const nameParts = String(rawValue).trim().split(/\s+/);
      if (modifier === "first") return nameParts[0] || "";
      if (modifier === "last") return nameParts.slice(1).join(" ") || nameParts[0] || "";
    }

    return rawValue; // unknown modifier → full value
  }

  // No modifier → direct value, with alias + case-insensitive fallback
  // Date object হলে ISO string-এ convert
  if (flat[fieldKey] instanceof Date) return flat[fieldKey].toISOString().slice(0, 10);
  if (flat[fieldKey] !== undefined && flat[fieldKey] !== "") return flat[fieldKey];

  // Alias lookup
  const alias = KEY_ALIASES[fieldKey.toLowerCase()];
  if (alias && flat[alias] !== undefined && flat[alias] !== "") return flat[alias];

  // Case-insensitive search — flat keys-এ exact match না পেলে
  const lowerKey = fieldKey.toLowerCase();
  for (const [k, v] of Object.entries(flat)) {
    if (k.toLowerCase() === lowerKey && v !== undefined && v !== "") return v;
  }

  return flat[fieldKey] ?? "";
}

function colLetter(col) {
  let s = "";
  while (col > 0) { col--; s = String.fromCharCode(65 + (col % 26)) + s; col = Math.floor(col / 26); }
  return s;
}

function getCellText(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return "";
  try {
    // richText format (styled text)
    if (cell.value && cell.value.richText) {
      return cell.value.richText.map(r => r.text || "").join("").trim();
    }
    // formula result
    if (cell.value && typeof cell.value === "object" && cell.value.result !== undefined) {
      return cell.value.result != null ? String(cell.value.result).trim() : "";
    }
    // text property (most common)
    if (cell.text) return String(cell.text).trim();
    // direct value
    return cell.value != null ? String(cell.value).trim() : "";
  } catch {
    return "";
  }
}

function encName(s) {
  return (s || "export").replace(/[^a-zA-Z0-9_\-\u0980-\u09FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF ]/g, "").substring(0, 50);
}

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

// Check if text looks like a form label (not user data)
function isLabel(text) {
  if (!text || text.length > 50) return false;
  // Japanese labels: contains kanji/katakana form words
  if (/[氏名前生年月日性別国籍住所学歴旅券番号電話職業婚姻区分出生地戸籍携帯学校入学卒業資格]/.test(text)) return true;
  // English labels
  if (/^(name|sex|date|birth|address|phone|tel|email|passport|school|nationality|occupation|marital|full name|status)/i.test(text)) return true;
  // Form keywords
  if (/^(elementary|junior|high|college|university|technical)/i.test(text)) return true;
  if (/^(year|month|day|no\.|number)/i.test(text)) return true;
  // Bengali labels
  if (/[নামঠিকানাফোনজন্মপিতামাতাপেশা]/.test(text)) return true;
  // Short text with specific patterns
  if (/^[A-Z][a-z]+\s+(of|for|from|in)\s/i.test(text)) return true;
  // Column headers
  if (/^(date of|name of|place of)/i.test(text)) return true;
  return false;
}

// Auto-detect system field from label text
function autoDetect(label) {
  if (!label) return "";
  const l = label.toLowerCase();
  // More comprehensive rules for real Japanese school forms
  const rules = [
    // Personal - exact patterns from real forms
    [["full name", "氏名", "alphabet", "ふりがな"], "name_en"],
    [["カタカナ", "katakana", "フリガナ"], "name_katakana"],
    [["生年月日", "date of birth", "birthday", "誕生日"], "dob"],
    [["性別", "sex", "gender", "男女"], "gender"],
    [["国籍", "nationality"], "nationality"],
    [["出生地", "place of birth", "birthplace"], "permanent_address"],
    [["婚姻", "marital", "single", "married"], "marital_status"],
    [["name of spouse", "配偶者"], "spouse_name"],
    [["職業", "occupation"], "father_occupation"],

    // Contact
    [["電話番号", "telephone", "phone", "tel", "携帯"], "phone"],
    [["メール", "email", "e-mail"], "email"],

    // Address
    [["戸籍住所", "registered address", "本籍"], "permanent_address"],
    [["現住所", "present address", "現在の住所"], "current_address"],

    // Passport
    [["旅券番号", "passport no", "passport number"], "passport_number"],
    [["発行日", "date of issue", "発行年月日"], "passport_issue"],
    [["有効期限", "date of expir", "有効期間"], "passport_expiry"],

    // Family
    [["父の名前", "father", "父親"], "father_name_en"],
    [["母の名前", "mother", "母親"], "mother_name_en"],

    // Education
    [["elementary", "小学校", "初等"], "edu_ssc_school"],
    [["junior high", "中学校", "中等"], "edu_ssc_school"],
    [["high school", "高等学校", "高校"], "edu_hsc_school"],
    [["college", "大学", "短期大学"], "edu_honours_school"],
    [["university", "大学院"], "edu_honours_school"],
    [["technical", "専門学校"], "edu_honours_school"],
    [["学校名", "name of school", "学校"], "edu_ssc_school"],
    [["入学年", "date of entrance", "入学"], "edu_ssc_year"],
    [["卒業年", "date of graduat", "卒業"], "edu_ssc_year"],

    // Japanese
    [["日本語能力", "jlpt", "japanese language"], "jp_level"],
    [["日本語学習歴", "japanese study"], "jp_exam_type"],

    // Sponsor
    [["経費支弁者", "sponsor", "保証人", "支弁者"], "sponsor_name"],
    [["年収", "annual income", "収入"], "sponsor_income_y1"],
    [["勤務先", "employer", "会社"], "sponsor_company"],

    // Visa
    [["在留資格", "status of residence", "visa status"], "visa_type"],
    [["入国目的", "purpose of entry"], "visa_type"],
    [["入国日", "date of entry"], ""],
    [["出国日", "date of departure"], ""],
  ];

  for (const [keywords, field] of rules) {
    if (keywords.some((k) => l.includes(k))) return field;
  }
  return "";
}

// Resolve template file — download from Supabase Storage if needed
async function resolveTemplatePath(templateUrl) {
  // If it's a local file path that exists, use it
  if (fs.existsSync(templateUrl)) return templateUrl;

  // Otherwise download from Supabase Storage
  const { data, error } = await supabase.storage.from("templates").download(templateUrl);
  if (error) {
    console.error("Storage download error:", error.message);
    throw new Error("Template ফাইল ডাউনলোড ব্যর্থ");
  }

  // Save to temp file
  const tempPath = path.join(__dirname, "../../uploads", `temp_${Date.now()}.xlsx`);
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

// Fill a single student into a fresh copy of the template — ALL sheets
async function fillSingleStudent(templateUrl, mappings, student) {
  const templatePath = await resolveTemplatePath(templateUrl);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  // Clean up temp file if it was downloaded
  if (templatePath.includes("temp_")) {
    setTimeout(() => { try { fs.unlinkSync(templatePath); } catch {} }, 5000);
  }

  // Group mappings by sheet name
  const bySheet = {};
  for (const m of mappings) {
    const sheetKey = m.sheet || workbook.worksheets[0]?.name || "Sheet1";
    if (!bySheet[sheetKey]) bySheet[sheetKey] = [];
    bySheet[sheetKey].push(m);
  }

  // Fill each sheet that has mappings
  for (const [sheetName, sheetMappings] of Object.entries(bySheet)) {
    const sheet = workbook.getWorksheet(sheetName);
    if (sheet) {
      fillSheetData(sheet, sheetMappings, student);
    }
  }

  // Also fill sheets with mappings that don't have sheet name (legacy)
  const noSheetMappings = mappings.filter((m) => !m.sheet);
  if (noSheetMappings.length > 0) {
    for (const sheet of workbook.worksheets) {
      fillSheetData(sheet, noSheetMappings, student);
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Fill mapped data into a sheet — handles merged cells + modifier support
function fillSheetData(sheet, mappings, student) {
  const flat = flattenStudent(student);
  for (const m of mappings) {
    if (!m.field || !m.cell) continue;
    // resolveFieldValue ব্যবহার — :year, :month, :day, alias সব support করে
    const value = resolveFieldValue(flat, m.field);
    if (!value) continue;
    try {
      const cell = sheet.getCell(m.cell);
      // Preserve style, font, border — only change value
      const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
      // সবসময় string হিসেবে set করো — Date object এড়ানো
      cell.value = String(value);
      cell.style = oldStyle;
    } catch { /* invalid cell ref or merged cell issue, skip */ }
  }
}

// Deep copy sheet preserving format, merges, print settings
function copySheet(src, dest) {
  // Copy page setup / print settings
  if (src.pageSetup) {
    try { dest.pageSetup = JSON.parse(JSON.stringify(src.pageSetup)); } catch {}
  }

  // Copy column widths
  src.columns.forEach((col, i) => {
    const destCol = dest.getColumn(i + 1);
    if (col.width) destCol.width = col.width;
    if (col.hidden) destCol.hidden = col.hidden;
    if (col.style) destCol.style = JSON.parse(JSON.stringify(col.style));
  });

  // Copy rows with all cell data and styles FIRST
  src.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const destRow = dest.getRow(rowNumber);
    destRow.height = row.height;
    if (row.hidden) destRow.hidden = row.hidden;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const destCell = destRow.getCell(colNumber);
      destCell.value = cell.value;
      try { destCell.style = JSON.parse(JSON.stringify(cell.style || {})); } catch {}
      if (cell.numFmt) destCell.numFmt = cell.numFmt;
    });

    destRow.commit();
  });

  // Copy merged cells AFTER rows (must be done after cells exist)
  if (src._merges) {
    for (const [, merge] of Object.entries(src._merges)) {
      try {
        const model = merge.model || merge;
        if (typeof model === "string") {
          dest.mergeCells(model);
        } else if (model.top && model.left && model.bottom && model.right) {
          dest.mergeCells(model.top, model.left, model.bottom, model.right);
        }
      } catch { /* skip merge conflicts */ }
    }
  }
}

// CSV fallback
function generateCSV(res, tmpl, students) {
  const mapped = (tmpl.mappings || []).filter((m) => m.field);
  const headers = mapped.map((m) => m.label || m.field);
  const rows = students.map((s) => {
    const flat = flattenStudent(s);
    return mapped.map((m) => {
      const val = String(flat[m.field] || "").replace(/"/g, '""');
      return val.includes(",") || val.includes("\n") ? `"${val}"` : val;
    }).join(",");
  });
  const csv = "\uFEFF" + headers.join(",") + "\n" + rows.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${students.length}students.csv"`);
  res.send(csv);
}

// Flatten student + related data into a key-value map
// দ্বিতীয় flattenStudent সরানো হয়েছে — line 519-এর বিস্তারিত version ব্যবহার হবে

// System fields for frontend
const SYSTEM_FIELDS = [
  { group: "ব্যক্তিগত", source: "Student → Profile → Personal Info", fields: [
    { key: "name_en", label: "নাম (English)" }, { key: "name_bn", label: "নাম (বাংলা)" },
    { key: "name_katakana", label: "নাম (カタカナ)" }, { key: "dob", label: "জন্ম তারিখ" },
    { key: "dob:year", label: "জন্ম → বছর" }, { key: "dob:month", label: "জন্ম → মাস" }, { key: "dob:day", label: "জন্ম → দিন" },
    { key: "age", label: "বয়স (auto)" }, { key: "gender", label: "লিঙ্গ" },
    { key: "marital_status", label: "বৈবাহিক অবস্থা" }, { key: "nationality", label: "জাতীয়তা" },
    { key: "blood_group", label: "রক্তের গ্রুপ" }, { key: "phone", label: "ফোন" },
    { key: "whatsapp", label: "WhatsApp" }, { key: "email", label: "ইমেইল" },
    { key: "birth_place", label: "জন্মস্থান" }, { key: "occupation", label: "পেশা" },
    { key: "spouse_name", label: "স্বামী/স্ত্রীর নাম" },
    { key: "emergency_contact", label: "জরুরি যোগাযোগ" }, { key: "emergency_phone", label: "জরুরি ফোন" },
  ]},
  { group: "পাসপোর্ট / NID", source: "Student → Profile → Passport & Family", fields: [
    { key: "nid", label: "NID নম্বর" }, { key: "passport_number", label: "পাসপোর্ট নম্বর" },
    { key: "passport_issue", label: "পাসপোর্ট ইস্যু" }, { key: "passport_expiry", label: "পাসপোর্ট মেয়াদ" },
    { key: "passport_issue:year", label: "ইস্যু → বছর" }, { key: "passport_issue:month", label: "ইস্যু → মাস" }, { key: "passport_issue:day", label: "ইস্যু → দিন" },
    { key: "passport_expiry:year", label: "মেয়াদ → বছর" }, { key: "passport_expiry:month", label: "মেয়াদ → মাস" }, { key: "passport_expiry:day", label: "মেয়াদ → দিন" },
  ]},
  { group: "ঠিকানা", source: "Student → Profile → Personal Info", fields: [
    { key: "permanent_address", label: "স্থায়ী ঠিকানা" }, { key: "current_address", label: "বর্তমান ঠিকানা" },
  ]},
  { group: "পরিবার", source: "Student → Profile → Family Members (Add)", fields: [
    { key: "father_name_en", label: "পিতার নাম" }, { key: "mother_name_en", label: "মাতার নাম" },
    { key: "father_dob", label: "পিতার জন্ম তারিখ" }, { key: "father_occupation", label: "পিতার পেশা" },
    { key: "mother_dob", label: "মাতার জন্ম তারিখ" }, { key: "mother_occupation", label: "মাতার পেশা" },
    { key: "father_phone", label: "পিতার ফোন" }, { key: "mother_phone", label: "মাতার ফোন" },
  ]},
  { group: "শিক্ষা (SSC/HSC/Honours)", source: "Student → Profile → Education", fields: [
    { key: "edu_ssc_school", label: "SSC স্কুল" }, { key: "edu_ssc_year", label: "SSC সন" },
    { key: "edu_ssc_board", label: "SSC বোর্ড" }, { key: "edu_ssc_gpa", label: "SSC GPA" },
    { key: "edu_ssc_subject", label: "SSC বিভাগ" }, { key: "edu_ssc_address", label: "SSC ঠিকানা" },
    { key: "edu_ssc_entrance", label: "SSC ভর্তি সন" },
    { key: "edu_hsc_school", label: "HSC কলেজ" }, { key: "edu_hsc_year", label: "HSC সন" },
    { key: "edu_hsc_board", label: "HSC বোর্ড" }, { key: "edu_hsc_gpa", label: "HSC GPA" },
    { key: "edu_hsc_subject", label: "HSC বিভাগ" }, { key: "edu_hsc_address", label: "HSC ঠিকানা" },
    { key: "edu_hsc_entrance", label: "HSC ভর্তি সন" },
    { key: "edu_honours_school", label: "Honours বিশ্ববিদ্যালয়" }, { key: "edu_honours_year", label: "Honours সন" },
    { key: "edu_honours_gpa", label: "Honours GPA" }, { key: "edu_honours_subject", label: "Honours বিষয়" },
    { key: "edu_honours_address", label: "Honours ঠিকানা" }, { key: "edu_honours_entrance", label: "Honours ভর্তি সন" },
  ]},
  { group: "শিক্ষা (日本語履歴書)", source: "Student → Profile → Education (School Type select)", fields: [
    { key: "edu_elementary_school", label: "প্রাথমিক (小学校) স্কুল" }, { key: "edu_elementary_address", label: "প্রাথমিক ঠিকানা" },
    { key: "edu_elementary_entrance", label: "প্রাথমিক ভর্তি" }, { key: "edu_elementary_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_elementary_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_elementary_graduation", label: "প্রাথমিক পাশ" }, { key: "edu_elementary_graduation:year", label: "পাশ → বছর" }, { key: "edu_elementary_graduation:month", label: "পাশ → মাস" },
    { key: "edu_elementary_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_junior_school", label: "জুনিয়র হাই (中学校)" }, { key: "edu_junior_address", label: "জুনিয়র ঠিকানা" },
    { key: "edu_junior_entrance", label: "জুনিয়র ভর্তি" }, { key: "edu_junior_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_junior_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_junior_graduation", label: "জুনিয়র পাশ" }, { key: "edu_junior_graduation:year", label: "পাশ → বছর" }, { key: "edu_junior_graduation:month", label: "পাশ → মাস" },
    { key: "edu_junior_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_highSchool_school", label: "হাই স্কুল (高等学校)" }, { key: "edu_highSchool_address", label: "হাই স্কুল ঠিকানা" },
    { key: "edu_highSchool_entrance", label: "হাই স্কুল ভর্তি" }, { key: "edu_highSchool_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_highSchool_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_highSchool_graduation", label: "হাই স্কুল পাশ" }, { key: "edu_highSchool_graduation:year", label: "পাশ → বছর" }, { key: "edu_highSchool_graduation:month", label: "পাশ → মাস" },
    { key: "edu_highSchool_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_technical_school", label: "টেকনিক্যাল (専門学校)" }, { key: "edu_technical_address", label: "ঠিকানা" },
    { key: "edu_technical_entrance", label: "ভর্তি" }, { key: "edu_technical_graduation", label: "পাশ" },
    { key: "edu_university_school", label: "বিশ্ববিদ্যালয় (大学)" }, { key: "edu_university_address", label: "ঠিকানা" },
    { key: "edu_university_entrance", label: "ভর্তি" }, { key: "edu_university_graduation", label: "পাশ" },
  ]},
  { group: "জাপানি ভাষা পরীক্ষা", source: "Student → Profile → JP Exams", fields: [
    { key: "jp_exam_type", label: "পরীক্ষার ধরন" }, { key: "jp_level", label: "লেভেল" },
    { key: "jp_score", label: "স্কোর" }, { key: "jp_result", label: "ফলাফল" },
    { key: "jp_exam_date", label: "পরীক্ষার তারিখ" }, { key: "jp_exam_date:year", label: "পরীক্ষা → বছর" }, { key: "jp_exam_date:month", label: "পরীক্ষা → মাস" }, { key: "jp_exam_date:day", label: "পরীক্ষা → দিন" },
  ]},
  { group: "জাপানি ভাষা শিক্ষা", source: "Auto: Agency নাম + Batch dates | Manual: JP Study Add", fields: [
    { key: "jp_study_institution", label: "প্রতিষ্ঠান" },
    { key: "jp_study_address", label: "প্রতিষ্ঠানের ঠিকানা" },
    { key: "jp_study_from", label: "শুরু তারিখ" }, { key: "jp_study_from:year", label: "শুরু → বছর" }, { key: "jp_study_from:month", label: "শুরু → মাস" }, { key: "jp_study_from:day", label: "শুরু → দিন" },
    { key: "jp_study_to", label: "শেষ তারিখ" }, { key: "jp_study_to:year", label: "শেষ → বছর" }, { key: "jp_study_to:month", label: "শেষ → মাস" }, { key: "jp_study_to:day", label: "শেষ → দিন" },
    { key: "jp_study_hours", label: "মোট ঘন্টা" },
  ]},
  { group: "কর্ম অভিজ্ঞতা (職歴)", source: "Student → Profile → Work Experience", fields: [
    { key: "work_company", label: "কোম্পানি নাম" }, { key: "work_address", label: "কোম্পানি ঠিকানা" },
    { key: "work_position", label: "পদবি" },
    { key: "work_start", label: "শুরু তারিখ" }, { key: "work_start:year", label: "শুরু → বছর" }, { key: "work_start:month", label: "শুরু → মাস" },
    { key: "work_end", label: "শেষ তারিখ" }, { key: "work_end:year", label: "শেষ → বছর" }, { key: "work_end:month", label: "শেষ → মাস" },
  ]},
  { group: "Study Plan", source: "Student → Profile → Purpose of Study", fields: [
    { key: "reason_for_study", label: "পড়ার কারণ" },
    { key: "future_plan", label: "ভবিষ্যৎ পরিকল্পনা" }, { key: "study_subject", label: "বিষয়" },
  ]},
  { group: "স্পন্সর", source: "Student → Sponsor Tab", fields: [
    { key: "sponsor_name", label: "নাম" }, { key: "sponsor_name_en", label: "নাম (EN)" },
    { key: "sponsor_relationship", label: "সম্পর্ক" }, { key: "sponsor_phone", label: "ফোন" },
    { key: "sponsor_dob", label: "জন্ম তারিখ" }, { key: "sponsor_dob:year", label: "জন্ম → বছর" }, { key: "sponsor_dob:month", label: "জন্ম → মাস" }, { key: "sponsor_dob:day", label: "জন্ম → দিন" },
    { key: "sponsor_nid", label: "NID" },
    { key: "sponsor_father_name", label: "পিতার নাম" }, { key: "sponsor_mother_name", label: "মাতার নাম" },
    { key: "sponsor_present_address", label: "বর্তমান ঠিকানা" }, { key: "sponsor_permanent_address", label: "স্থায়ী ঠিকানা" },
    { key: "sponsor_address", label: "ঠিকানা" },
    { key: "sponsor_company", label: "কোম্পানি" }, { key: "sponsor_company_phone", label: "কোম্পানি ফোন" },
    { key: "sponsor_company_address", label: "কোম্পানি ঠিকানা" }, { key: "sponsor_work_address", label: "কর্মস্থল" },
    { key: "sponsor_trade_license", label: "ট্রেড লাইসেন্স" },
    { key: "sponsor_tin", label: "TIN" },
    { key: "sponsor_income_year_1", label: "আয় সন (১ম)" }, { key: "sponsor_income_y1", label: "আয় (১ম)" }, { key: "sponsor_tax_y1", label: "ট্যাক্স (১ম)" },
    { key: "sponsor_income_year_2", label: "আয় সন (২য়)" }, { key: "sponsor_income_y2", label: "আয় (২য়)" }, { key: "sponsor_tax_y2", label: "ট্যাক্স (২য়)" },
    { key: "sponsor_income_year_3", label: "আয় সন (৩য়)" }, { key: "sponsor_income_y3", label: "আয় (৩য়)" }, { key: "sponsor_tax_y3", label: "ট্যাক্স (৩য়)" },
    { key: "sponsor_statement", label: "স্পন্সরশিপ বিবৃতি" },
  ]},
  { group: "গন্তব্য", source: "Student → Profile → Destination Info", fields: [
    { key: "country", label: "দেশ" }, { key: "intake", label: "Intake" },
    { key: "visa_type", label: "ভিসার ধরন" }, { key: "student_type", label: "টাইপ" },
    { key: "source", label: "সোর্স" }, { key: "branch", label: "ব্রাঞ্চ" }, { key: "status", label: "স্ট্যাটাস" },
  ]},
  { group: "সিস্টেম ভ্যারিয়েবল", source: "Auto: Settings / Batch / School থেকে", fields: [
    { key: "sys_agency_name", label: "এজেন্সি নাম" }, { key: "sys_agency_address", label: "এজেন্সি ঠিকানা" },
    { key: "sys_agency_phone", label: "এজেন্সি ফোন" }, { key: "sys_agency_email", label: "এজেন্সি ইমেইল" },
    { key: "sys_branch_name", label: "ব্রাঞ্চ নাম" }, { key: "sys_branch_address", label: "ব্রাঞ্চ ঠিকানা" },
    { key: "sys_today", label: "আজকের তারিখ" }, { key: "sys_today:year", label: "আজ → বছর" }, { key: "sys_today:month", label: "আজ → মাস" }, { key: "sys_today:day", label: "আজ → দিন" },
    { key: "sys_today_jp", label: "আজকের তারিখ (日本語)" },
    { key: "sys_batch_name", label: "ব্যাচ নাম" }, { key: "sys_batch_start", label: "ব্যাচ শুরু" },
    { key: "sys_batch_start:year", label: "শুরু → বছর" }, { key: "sys_batch_start:month", label: "শুরু → মাস" }, { key: "sys_batch_start:day", label: "শুরু → দিন" },
    { key: "sys_batch_end", label: "ব্যাচ শেষ" }, { key: "sys_batch_end:year", label: "শেষ → বছর" }, { key: "sys_batch_end:month", label: "শেষ → মাস" }, { key: "sys_batch_end:day", label: "শেষ → দিন" },
    { key: "sys_batch_teacher", label: "শিক্ষক" }, { key: "sys_batch_schedule", label: "সময়সূচী" },
    { key: "sys_school_name", label: "স্কুল (EN)" }, { key: "sys_school_name_jp", label: "স্কুল (JP)" }, { key: "sys_school_address", label: "স্কুল ঠিকানা" },
  ]},
];

// ================================================================
// AI Excel Analysis — Template-এ placeholder auto-detect
// ExcelJS parse → structured cell map → Claude Haiku → suggestions
// ================================================================

// সব field keys একটি flat list-এ — AI prompt-এ ব্যবহার হবে
const ALL_FIELD_KEYS = SYSTEM_FIELDS.flatMap(g => g.fields.map(f => f.key));

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

// Column letter → number helper (A=1, B=2, ... Z=26, AA=27)
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
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
 * analyzeWithClaude — Claude Haiku API call
 * OCR route-এর extractWithHaiku() pattern follow করে
 */
async function analyzeWithClaude(sheetData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[AI Excel] ANTHROPIC_API_KEY not set");
    return null;
  }

  const prompt = buildAIPrompt(sheetData);

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
