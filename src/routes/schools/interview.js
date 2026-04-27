/**
 * interview.js — Interview list Excel download route
 *
 * POST /:id/interview-list — student_ids + agency/staff info → Excel download
 *
 * Template resolution: school-specific → default → system-generated
 *   - Saved mapping থাকলে সেটা ব্যবহার
 *   - না থাকলে auto-detect: row-wise vs column-wise
 *   - Template না থাকলে system-generated basic export
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const { uploadDir } = require("./_shared");
const { studentToFlat } = require("../../lib/schools/studentToFlat");

const router = express.Router();
router.use(auth);

// POST /api/schools/:id/interview-list — Excel download (template-based)
router.post("/:id/interview-list", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { student_ids, format, agency_name, staff_name, columns } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: "student_ids দিন" });
  }

  // Students fetch — related data সহ (education, jp_exams, sponsors)
  const { data: studentsRaw, error: studErr } = await supabase.from("students").select("*")
    .in("id", student_ids).eq("agency_id", req.user.agency_id);
  console.log("[Interview] Requested:", student_ids.length, "| Fetched:", (studentsRaw || []).length, studErr ? `Error: ${studErr.message}` : "");

  // Related data bulk fetch — education, jp_exams, sponsors
  const sIds = (studentsRaw || []).map(s => s.id);
  const [eduRes, jpRes, spRes] = await Promise.all([
    supabase.from("student_education").select("student_id, level, gpa, school_name, year").in("student_id", sIds),
    supabase.from("student_jp_exams").select("student_id, level, score, exam_type").in("student_id", sIds),
    supabase.from("sponsors").select("student_id, name, name_en, relationship, phone, annual_income_y1, company_name").in("student_id", sIds),
  ]);
  // student_id → related data map
  const eduMap = {}, jpMap = {}, spMap = {};
  (eduRes.data || []).forEach(e => { if (!eduMap[e.student_id]) eduMap[e.student_id] = []; eduMap[e.student_id].push(e); });
  (jpRes.data || []).forEach(j => { if (!jpMap[j.student_id]) jpMap[j.student_id] = []; jpMap[j.student_id].push(j); });
  (spRes.data || []).forEach(s => { spMap[s.student_id] = s; });

  // Students-এ related data merge
  const students = (studentsRaw || []).map(s => {
    const edu = eduMap[s.id] || [];
    const jp = jpMap[s.id] || [];
    const sp = spMap[s.id] || {};
    // সবচেয়ে ভালো education level ও GPA
    let bestEdu = "", bestGpa = "";
    edu.forEach(e => { if (e.level) { bestEdu = e.level; if (e.gpa) bestGpa = e.gpa; } });
    // সবচেয়ে ভালো JP level
    const JP_RANK = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };
    let bestJp = "", bestJpScore = "";
    jp.forEach(j => { if ((JP_RANK[j.level] || 0) > (JP_RANK[bestJp] || 0)) { bestJp = j.level; bestJpScore = j.score || ""; } });
    return {
      ...s,
      last_education: bestEdu, gpa: bestGpa,
      jp_level: bestJp, jp_score: bestJpScore, jp_exam_type: jp[0]?.exam_type || "",
      jp_study_hours: s.jp_study_hours || "",
      sponsor_name: sp.name || sp.name_en || "", sponsor_relation: sp.relationship || "",
      sponsor_income: sp.annual_income_y1 ? `৳${Number(sp.annual_income_y1).toLocaleString("en-IN")}` : "",
      sponsor_phone: sp.phone || "", sponsor_company: sp.company_name || "",
    };
  }).sort((a, b) => student_ids.indexOf(a.id) - student_ids.indexOf(b.id));

  // School fetch
  const { data: school } = await supabase.from("schools").select("*").eq("id", req.params.id).single();
  const ExcelJS = require("exceljs");

  // ── Template resolution: school-specific → default → system-generated ──
  let templatePath = null;
  // 1. স্কুল-specific template
  if (school?.interview_template) {
    const p = path.join(uploadDir, school.interview_template);
    if (fs.existsSync(p)) templatePath = p;
  }
  // 2. Default template (uploads/interview-templates/default.xlsx)
  if (!templatePath) {
    const defaultPath = path.join(uploadDir, "default.xlsx");
    if (fs.existsSync(defaultPath)) templatePath = defaultPath;
  }

  // ── Template-based export ──
  if (templatePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(templatePath);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(500).json({ error: "টেমপ্লেটে কোনো শীট নেই" });

    // ── Saved mapping আছে? সেটা ব্যবহার করো ──
    let savedMapping = null;
    try { savedMapping = JSON.parse(school?.interview_template_mapping || "null"); } catch {}

    if (savedMapping && savedMapping.mapping && savedMapping.mapping.length > 0) {
      const isCol = savedMapping.format === "column";
      const headerRow = savedMapping.header_row || 3;

      // Agency name fill (row 1)
      const r1 = String(ws.getCell(1, 1).value || "").toLowerCase();
      if (r1.includes("agent") || r1.includes("行名") || r1.includes("agency")) {
        ws.getCell(1, 1).value = `行名(Agent Name): ${agency_name || ""}`;
        for (let c = 2; c <= 10; c++) ws.getCell(1, c).value = "";
      }

      if (isCol) {
        // Column-wise: mapping[i].position = row, mapping[i].field = student field
        const dataStartCol = 2;
        students.forEach((s, si) => {
          const flat = studentToFlat(s, si, agency_name, staff_name);
          const col = dataStartCol + si;
          savedMapping.mapping.forEach(m => {
            if (m.field && m.position) ws.getCell(m.position, col).value = flat[m.field] || "";
          });
        });
      } else {
        // Row-wise: mapping[i].position = col, mapping[i].field = student field
        const dataStartRow = headerRow + 1;
        students.forEach((s, si) => {
          const flat = studentToFlat(s, si, agency_name, staff_name);
          const row = ws.getRow(dataStartRow + si);
          savedMapping.mapping.forEach(m => {
            if (m.field && m.position) row.getCell(m.position).value = flat[m.field] || "";
          });
          row.commit();
        });
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Interview_${school?.name_en || "List"}_${students.length}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    // ── Saved mapping নেই → auto-detect fallback ──
    const isColumnWise = format === "column";

    if (isColumnWise) {
      // ── Column-wise: প্রতি student = ১টি column ──
      // Label column (A বা first col) — data columns start from B onward
      // Scan label column for known keywords → map to student fields
      const LABEL_MAP = {
        "full name": "full_name", "name shown on passport": "full_name", "passport name": "full_name",
        "family name": "family_name", "sir name": "family_name", "氏": "family_name",
        "given name": "given_name", "first name": "given_name", "名": "given_name",
        "gender": "gender", "性別": "gender",
        "date of birth": "dob_age", "出生年月日": "dob_age", "dob": "dob_age", "birth": "dob_age",
        "nationality": "nationality", "nation or region": "nationality", "citizenship": "nationality",
        "occupation": "occupation", "職業": "occupation",
        "education": "education", "most recent institution": "education", "type of school": "education", "最終学歴": "education",
        "date of graduation": "gpa",
        "studied japanese": "has_jp_cert", "japanese": "has_jp_cert",
        "attained level": "jp_level", "jp level": "jp_level", "score": "jp_score",
        "goal": "goal", "goal following graduation": "goal",
        "passport": "passport_no", "パスポート": "passport_no",
        "phone": "phone", "email": "email", "address": "address",
        "sponsor": "sponsor", "経費支弁者": "sponsor",
        "intake": "intended_semester", "semester": "intended_semester",
        "gpa": "gpa",
        "agent": "agency_name", "エージェント": "agency_name", "行名": "agency_name",
        "リンクスタッフ": "staff_name", "担当者": "staff_name", "記入者": "staff_name",
        "学生": "no", "student no": "no",
      };

      // Scan first column for labels
      const rowCount = ws.rowCount || 30;
      const labelCol = 1; // A column
      const dataStartCol = 2; // B column onward (1st data col may have number headers)
      // Find actual data start — look for "1" or first number in row
      let numberRow = -1;
      for (let r = 1; r <= Math.min(rowCount, 10); r++) {
        const cell = ws.getCell(r, dataStartCol);
        if (cell.value && /^[1-9]$/.test(String(cell.value).trim())) { numberRow = r; break; }
      }

      // Map labels → row numbers
      const labelRows = {};
      for (let r = 1; r <= rowCount; r++) {
        const cellVal = String(ws.getCell(r, labelCol).value || "").toLowerCase().trim();
        if (!cellVal) continue;
        for (const [keyword, field] of Object.entries(LABEL_MAP)) {
          if (cellVal.includes(keyword)) { labelRows[field] = r; break; }
        }
      }

      // Fill student data — each student gets a column
      students.forEach((s, i) => {
        const flat = studentToFlat(s, i, agency_name, staff_name);
        const col = dataStartCol + i;
        // Student number header (যেখানে 1, 2, 3... আছে)
        if (numberRow > 0) ws.getCell(numberRow, col).value = i + 1;
        // Fill mapped rows
        for (const [field, row] of Object.entries(labelRows)) {
          const val = flat[field] || "";
          if (val) ws.getCell(row, col).value = val;
        }
      });

    } else {
      // ── Row-wise: প্রতি student = ১টি row ──
      // Header row detect — keyword → student field mapping
      // কীওয়ার্ড ম্যাচিং: exact word/phrase match (includes false positive avoid)
      const HEADER_RULES = [
        { test: v => /^no\.?$/i.test(v.trim()), field: "no" },
        { test: v => /ক্রমিক/i.test(v), field: "no" },
        { test: v => /family|sir\s*name|氏/i.test(v), field: "family_name" },
        { test: v => /given\s*name|first\s*name|名\s*given/i.test(v), field: "given_name" },
        { test: v => /gender|性別|m\/f/i.test(v), field: "gender" },
        { test: v => /birth|生年月日|年齢|dob|date of birth/i.test(v), field: "dob_age" },
        { test: v => /education|最終学歴|学歴/i.test(v), field: "education" },
        { test: v => /^gpa$/i.test(v.trim()), field: "gpa" },
        { test: v => /jp\s*level|日本語能力|日本語/i.test(v), field: "jp_level" },
        { test: v => /sponsor|経費支弁者|経費/i.test(v), field: "sponsor" },
        { test: v => /passport|パスポート/i.test(v), field: "passport_no" },
        { test: v => /phone|電話/i.test(v), field: "phone" },
        { test: v => /email|メール/i.test(v), field: "email" },
        { test: v => /address|住所/i.test(v), field: "address" },
        { test: v => /intake|semester/i.test(v), field: "intended_semester" },
        { test: v => /coe/i.test(v), field: "coe_applied" },
        { test: v => /goal|目標/i.test(v), field: "goal" },
        { test: v => /フジ|記入/i.test(v), field: "" }, // skip school-specific
      ];

      // Find header row
      let headerRowNum = -1;
      let colMap = {}; // colIndex → field
      for (let r = 1; r <= Math.min(ws.rowCount || 10, 10); r++) {
        const row = ws.getRow(r);
        let matchCount = 0;
        const tempMap = {};
        row.eachCell({ includeEmpty: false }, (cell, colNum) => {
          // ExcelJS richText support — extract plain text
          let val = "";
          if (cell.value && typeof cell.value === "object" && cell.value.richText) {
            val = cell.value.richText.map(r => r.text || "").join("");
          } else {
            val = String(cell.value || "");
          }
          val = val.replace(/\n/g, " ").trim();
          if (!val) return;
          for (const rule of HEADER_RULES) {
            if (rule.test(val)) {
              if (rule.field) { tempMap[colNum] = rule.field; matchCount++; }
              break;
            }
          }
        });
        if (matchCount >= 3) { headerRowNum = r; colMap = tempMap; break; }
      }

      if (headerRowNum === -1) {
        // Header পাওয়া যায়নি — row 3 assume (default template format)
        headerRowNum = 3;
        // Default column mapping for default template
        colMap = { 1: "no", 2: "family_name", 3: "given_name", 4: "gender", 5: "dob_age", 6: "education", 7: "gpa", 8: "jp_level", 9: "sponsor" };
      }

      console.log("[Interview] Header row:", headerRowNum, "colMap:", JSON.stringify(colMap));

      // Agency name fill (row 1 — 行名)
      const row1 = ws.getRow(1);
      const row1Val = String(ws.getCell(1, 1).value || "").toLowerCase();
      if (row1Val.includes("agent") || row1Val.includes("行名") || row1Val.includes("agency")) {
        // Unmerge cleanup — শুধু A1-তে label + agency name, বাকি clear
        ws.getCell(1, 1).value = `行名(Agent Name): ${agency_name || ""}`;
        for (let c = 2; c <= 10; c++) ws.getCell(1, c).value = "";
      }

      // Insert student rows after header
      const dataStartRow = headerRowNum + 1;
      students.forEach((s, i) => {
        const flat = studentToFlat(s, i, agency_name, staff_name);
        const targetRow = dataStartRow + i;
        const row = ws.getRow(targetRow);
        for (const [colStr, field] of Object.entries(colMap)) {
          const col = parseInt(colStr);
          row.getCell(col).value = flat[field] || "";
        }
        row.commit();
      });
    }

    // Send
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Interview_${school?.name_en || "List"}_${students.length}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }

  // ── No template — system generated basic export ──
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Interview List");

  // Header info rows
  ws.addRow([`行名(Agent Name): ${agency_name || "AgencyBook"}`]);
  ws.addRow([]);

  // Column headers — সব possible columns (Japanese + English)
  const ALL_HEADERS = [
    { key: "no", label: "No." },
    { key: "family_name", label: "氏 Sir Name\n(Family Name)" },
    { key: "given_name", label: "名 Given Name\n(First Name)" },
    { key: "full_name", label: "氏名\nFull Name" },
    { key: "gender", label: "性別\nGender\n(M/F)" },
    { key: "dob_age", label: "生年月日 (年齢)\nDate of Birth(Age)" },
    { key: "nationality", label: "国籍\nNationality" },
    { key: "education", label: "最終学歴\nEducation" },
    { key: "gpa", label: "GPA" },
    { key: "jp_level", label: "日本語能力\nJP Level/Score" },
    { key: "jp_study_hours", label: "日本語学習時間\nJP Study Hours" },
    { key: "occupation", label: "職業\nOccupation" },
    { key: "past_visa", label: "過去のビザ\nPast Visa" },
    { key: "sponsor", label: "経費支弁者\nSponsor (Income)" },
    { key: "sponsor_relation", label: "経費支弁者関係\nSponsor Relation" },
    { key: "passport_no", label: "パスポート番号\nPassport No" },
    { key: "phone", label: "電話番号\nPhone" },
    { key: "email", label: "メール\nEmail" },
    { key: "address", label: "住所\nAddress" },
    { key: "intended_semester", label: "入学希望期\nIntake" },
    { key: "coe_applied", label: "COE Applied" },
    { key: "textbook_lesson", label: "教科書\nTextbook Lesson" },
    { key: "goal", label: "卒業後の目標\nGoal" },
  ];
  const headerMap = Object.fromEntries(ALL_HEADERS.map(h => [h.key, h]));
  // User-selected columns → order preserve, অথবা default 9টা
  const DEFAULT_KEYS = ["no", "family_name", "given_name", "gender", "dob_age", "education", "gpa", "jp_level", "sponsor"];
  const activeCols = columns && columns.length > 0
    ? columns.map(k => headerMap[k]).filter(Boolean)
    : DEFAULT_KEYS.map(k => headerMap[k]);

  const headerRow = ws.addRow(activeCols.map(h => h.label));
  headerRow.font = { bold: true };
  headerRow.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };
    cell.font = { bold: true };
    cell.border = { bottom: { style: "thin" } };
  });

  // Student data rows
  students.forEach((s, i) => {
    const flat = studentToFlat(s, i, agency_name, staff_name);
    ws.addRow(activeCols.map(h => flat[h.key] || ""));
  });

  // Column width
  ws.columns.forEach(col => { col.width = 20; });

  // Send
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Interview_${school?.name_en || "List"}_${students.length}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
