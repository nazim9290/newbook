/**
 * generate.js — Excel generation routes (student data fill → .xlsx download)
 *
 * POST /generate          — bulk: template + student_ids[] → first student .xlsx
 * POST /generate-single   — single student generate (+ sys context)
 * POST /re-parse/:id      — existing template re-analyze + suggest mappings
 */

const express = require("express");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { colLetter, getCellText, encName } = require("../../lib/excel/cellUtils");
const { buildSystemContext } = require("../../lib/excel/systemContext");
const {
  getTemplateBuffer,
  fillSingleStudentFromBuffer,
  generateCSV,
} = require("../../lib/excel/templateFiller");
const { detectMappings } = require("../../lib/excel/aiAnalyzer");

const router = express.Router();
router.use(auth);

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
      const tmpPath = path.join(__dirname, "../../../uploads", `tmp_reparse_${Date.now()}.xls`);
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

module.exports = router;
