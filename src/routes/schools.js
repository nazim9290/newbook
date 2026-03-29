const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { dbError, sanitizeNumerics } = require("../lib/dbError");

const router = express.Router();
router.use(auth);

// Schools table-এ numeric columns — frontend থেকে string আসলে convert করবে
const NUMERIC_COLS = [
  "shoukai_fee", "tuition_y1", "tuition_y2", "admission_fee",
  "facility_fee", "dormitory_fee", "capacity", "commission_rate",
];

// Valid columns — শুধু এগুলো DB-তে পাঠাবে (extra fields ফেলে দেবে)
const SCHOOL_COLS = [
  "name_en", "name_jp", "country", "city", "prefecture", "postal_code", "address",
  "contact_person", "contact_email", "contact_phone", "website",
  ...NUMERIC_COLS,
  "min_jp_level", "interview_type", "has_dormitory",
  "deadline_april", "deadline_october", "status", "notes",
];

// GET /api/schools
router.get("/", checkPermission("schools", "read"), asyncHandler(async (req, res) => {
  const { country } = req.query;
  let query = supabase.from("schools").select("*").eq("agency_id", req.user.agency_id).order("name_en");
  if (country && country !== "All") query = query.eq("country", country);
  const { data, error } = await query;
  if (error) return dbError(res, error, "schools.list", 500);
  res.json(data);
}));

// POST /api/schools — নতুন স্কুল (numeric fields sanitize সহ)
router.post("/", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  // শুধু valid columns রাখো, numeric fields convert করো
  const record = { agency_id: req.user.agency_id };
  for (const col of SCHOOL_COLS) {
    if (req.body[col] !== undefined && req.body[col] !== "") record[col] = req.body[col];
  }
  const sanitized = sanitizeNumerics(record, NUMERIC_COLS);

  // boolean field
  if (req.body.has_dormitory !== undefined) sanitized.has_dormitory = !!req.body.has_dormitory;

  const { data, error } = await supabase.from("schools").insert(sanitized).select().single();
  if (error) return dbError(res, error, "schools.create");
  res.status(201).json(data);
}));

// PATCH /api/schools/:id
router.patch("/:id", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const updates = {};
  for (const col of SCHOOL_COLS) {
    if (req.body[col] !== undefined) updates[col] = req.body[col];
  }
  const sanitized = sanitizeNumerics(updates, NUMERIC_COLS);
  if (req.body.has_dormitory !== undefined) sanitized.has_dormitory = !!req.body.has_dormitory;

  const { data, error } = await supabase.from("schools").update(sanitized)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.update");
  res.json(data);
}));

// DELETE /api/schools/:id
router.delete("/:id", checkPermission("schools", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("schools").delete()
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return dbError(res, error, "schools.delete");
  res.json({ success: true });
}));

// GET /api/schools/:id/submissions
router.get("/:id/submissions", checkPermission("schools", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions")
    .select("*, students(name_en, phone, status)")
    .eq("school_id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .order("submission_date", { ascending: false });
  if (error) return dbError(res, error, "schools.submissions", 500);
  res.json(data);
}));

// POST /api/schools/:id/submissions
router.post("/:id/submissions", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions")
    .insert({ ...req.body, school_id: req.params.id, agency_id: req.user.agency_id })
    .select().single();
  if (error) return dbError(res, error, "schools.addSubmission");
  res.status(201).json(data);
}));

// PATCH /api/schools/submissions/:subId
router.patch("/submissions/:subId", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions").update(req.body)
    .eq("id", req.params.subId).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.updateSubmission");
  res.json(data);
}));

// ── Interview Template upload ──
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const uploadDir = path.join(__dirname, "../../uploads/interview-templates");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const templateUpload = multer({ dest: uploadDir, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/schools/:id/interview-template — টেমপ্লেট আপলোড
router.post("/:id/interview-template", checkPermission("schools", "write"), templateUpload.single("template"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
  // .xlsx extension দিয়ে rename
  const finalPath = req.file.path + ".xlsx";
  fs.renameSync(req.file.path, finalPath);
  // DB-তে template path সেভ
  const { data, error } = await supabase.from("schools")
    .update({ interview_template: path.basename(finalPath) })
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.uploadTemplate");
  res.json({ template: data.interview_template, message: "টেমপ্লেট আপলোড হয়েছে" });
}));

// DELETE /api/schools/:id/interview-template — টেমপ্লেট মুছুন
router.delete("/:id/interview-template", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data: school } = await supabase.from("schools").select("interview_template").eq("id", req.params.id).single();
  if (school?.interview_template) {
    const p = path.join(uploadDir, school.interview_template);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  await supabase.from("schools").update({ interview_template: null }).eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  res.json({ success: true });
}));

// ── Student data → flat object (সব template-এ ব্যবহার হবে) ──
function studentToFlat(s, i, agencyName, staffName) {
  const dob = s.dob ? new Date(s.dob) : null;
  const age = dob ? Math.floor((Date.now() - dob) / 31557600000) : "";
  const dobStr = s.dob || "";
  const dobAge = dobStr + (age ? ` (${age})` : "");
  // Family name / Given name split
  const parts = (s.name_en || "").trim().split(/\s+/);
  const familyName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  const givenName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  return {
    no: i + 1, serial: i + 1,
    name: s.name_en || "", full_name: s.name_en || "",
    family_name: familyName, given_name: givenName,
    name_bn: s.name_bn || "", name_jp: s.name_jp || "",
    gender: s.gender || "", gender_jp: s.gender === "Male" ? "男性" : s.gender === "Female" ? "女性" : "",
    dob: dobStr, dob_age: dobAge, age: String(age),
    nationality: s.nationality || "Bangladeshi",
    education: s.last_education || "", gpa: s.gpa || "",
    jp_level: s.jp_level || "", jp_score: s.jp_score || "", jp_exam_type: s.jp_exam_type || "",
    jp_study_hours: s.jp_study_hours || "", has_jp_cert: s.has_jp_cert ? "Yes" : "No",
    occupation: s.occupation || "Student",
    passport_no: s.passport_number || "", phone: s.phone || "", email: s.email || "",
    address: s.permanent_address || s.current_address || "",
    intake: s.intake || "", intended_semester: s.intake || "",
    sponsor: s.sponsor_name || "", sponsor_relation: s.sponsor_relation || "",
    sponsor_income: s.sponsor_income || "", sponsor_contact: s.sponsor_phone || "",
    coe_applied: s.coe_number ? "Yes" : "No",
    goal: s.goal_after_graduation || "Return to home country",
    goal_jp: s.goal_after_graduation || "帰国",
    past_visa: s.past_visa || "",
    // System variables
    agency_name: agencyName || "", staff_name: staffName || "",
    today: new Date().toISOString().slice(0, 10),
  };
}

// POST /api/schools/:id/interview-list — Excel download (template-based)
router.post("/:id/interview-list", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { student_ids, format, agency_name, staff_name, columns } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: "student_ids দিন" });
  }

  // Students fetch
  const { data: studentsRaw } = await supabase.from("students").select("*")
    .in("id", student_ids).eq("agency_id", req.user.agency_id);
  const students = (studentsRaw || []).sort((a, b) => student_ids.indexOf(a.id) - student_ids.indexOf(b.id));

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

    // Format detect: row-wise or column-wise
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

  // Column headers — default or user-selected
  const DEFAULT_HEADERS = [
    { key: "no", label: "No." }, { key: "family_name", label: "Family Name" },
    { key: "given_name", label: "Given Name" }, { key: "gender", label: "Gender" },
    { key: "dob_age", label: "Date of Birth(Age)" }, { key: "education", label: "Education" },
    { key: "gpa", label: "GPA" }, { key: "jp_level", label: "JP Level/Score" },
    { key: "sponsor", label: "Sponsor (Income)" },
  ];
  const activeCols = columns && columns.length > 0
    ? DEFAULT_HEADERS.filter(h => columns.includes(h.key))
    : DEFAULT_HEADERS;

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
