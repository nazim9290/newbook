const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/schools
router.get("/", async (req, res) => {
  const { country } = req.query;
  let query = supabase.from("schools").select("*").order("name_en");
  if (country && country !== "All") query = query.eq("country", country);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/schools — নতুন স্কুল তৈরি
router.post("/", async (req, res) => {
  const record = {
    ...req.body,
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
  };
  const { data, error } = await supabase.from("schools").insert(record).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/schools/:id
router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("schools").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/schools/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("schools").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/schools/:id/submissions
router.get("/:id/submissions", async (req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .select("*, students(name_en)")
    .eq("school_id", req.params.id)
    .order("submission_date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/schools/:id/submissions
router.post("/:id/submissions", async (req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .insert({ ...req.body, school_id: req.params.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/schools/submissions/:subId
router.patch("/submissions/:subId", async (req, res) => {
  const { data, error } = await supabase.from("submissions").update(req.body).eq("id", req.params.subId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ================================================================
// POST /api/schools/:id/interview-list
// Body: { student_ids: [...], format: "row" | "column", agency_name }
// Returns: .xlsx file — school interview student list
// ================================================================
router.post("/:id/interview-list", async (req, res) => {
  try {
    const { student_ids, format = "row", agency_name = "", staff_name = "", columns = [] } = req.body;
    if (!student_ids || !student_ids.length) return res.status(400).json({ error: "student_ids দিন" });

    // Get school info
    const { data: school } = await supabase.from("schools").select("*").eq("id", req.params.id).single();
    if (!school) return res.status(404).json({ error: "School পাওয়া যায়নি" });

    // Get students with related data
    const { data: students } = await supabase
      .from("students")
      .select("*, student_education(*), student_jp_exams(*), sponsors(*)")
      .in("id", student_ids);
    if (!students || !students.length) return res.status(400).json({ error: "কোনো student পাওয়া যায়নি" });

    // Get document_data for these students
    const { data: allDocData } = await supabase
      .from("document_data")
      .select("student_id, field_data")
      .in("student_id", student_ids);

    // Merge document data per student
    const docDataMap = {};
    (allDocData || []).forEach(dd => {
      docDataMap[dd.student_id] = { ...(docDataMap[dd.student_id] || {}), ...(dd.field_data || {}) };
    });

    // Decrypt
    const { decryptSensitiveFields } = require("../lib/crypto");

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();

    if (format === "column") {
      // ═══ Column-wise: each student = one column ═══
      const ws = wb.addWorksheet("Interview List");

      // Row labels (left side)
      const labels = [
        "学生no.", "リンクスタッフ担当者名", "記入者　名前", "エージェント名",
        "Intended Semester to Start", "Full name shown on passport",
        "Legal name in Chinese characters", "Gender of applicant",
        "Nation or region of citizenship", "Date of birth　出生年月日",
        "Occupation　職業", "Most recent institution　Type of school",
        "Date of graduation", "Have you ever studied Japanese?",
        "Attained level or score", "Goal following graduation",
      ];

      // Set column widths
      ws.getColumn(1).width = 45;
      students.forEach((_, i) => { ws.getColumn(i + 2).width = 25; });

      // Fill labels and data
      labels.forEach((label, rowIdx) => {
        const row = ws.getRow(rowIdx + 1);
        row.getCell(1).value = label;
        row.getCell(1).font = { bold: true, size: 10 };
        row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };

        students.forEach((stu, colIdx) => {
          const s = decryptSensitiveFields(stu);
          const dd = docDataMap[s.id] || {};
          const edu = (s.student_education || [])[0] || {};
          const jp = (s.student_jp_exams || [])[0] || {};
          const sp = (s.sponsors || [])[0] || {};

          let val = "";
          switch (rowIdx) {
            case 0: val = colIdx + 1; break;
            case 1: val = agency_name || ""; break;
            case 2: val = agency_name || ""; break;
            case 3: val = agency_name || ""; break;
            case 4: val = s.intake || ""; break;
            case 5: val = s.name_en || ""; break;
            case 6: val = s.name_katakana || ""; break;
            case 7: val = (s.gender || "") + (s.gender === "Male" ? " 男性" : s.gender === "Female" ? " 女性" : ""); break;
            case 8: val = s.nationality || "Bangladeshi"; break;
            case 9: val = s.dob || ""; break;
            case 10: val = "Student"; break;
            case 11: val = edu.level || "Bachelor"; break;
            case 12: val = edu.year || ""; break;
            case 13: val = jp.exam_type ? "Yes" : "No"; break;
            case 14: val = jp.level ? `${jp.exam_type || "JLPT"}/${jp.score || jp.level}` : ""; break;
            case 15: val = "Return to home country　帰国"; break;
          }
          row.getCell(colIdx + 2).value = val;
        });
      });

    } else {
      // ═══ Row-wise: each student = one row — dynamic columns ═══
      const ws = wb.addWorksheet("Student List");

      // Column config — key → header + data extractor
      const COL_CONFIG = {
        no: { header: "No.", width: 6, val: (s, idx) => idx + 1 },
        family_name: { header: "氏 Sir Name\n(Family Name)", width: 18, val: (s) => (s.name_en || "").split(/\s+/)[0] || "" },
        given_name: { header: "名 Given Name\n(First Name)", width: 18, val: (s) => (s.name_en || "").split(/\s+/).slice(1).join(" ") || "" },
        full_name: { header: "Full Name\n(Passport)", width: 25, val: (s) => s.name_en || "" },
        gender: { header: "性別\nGender\n(M/F)", width: 8, val: (s) => s.gender || "" },
        dob_age: { header: "生年月日(年齢)\nDate of Birth(Age)", width: 22, val: (s) => { const age = s.dob ? Math.floor((Date.now() - new Date(s.dob)) / (365.25*24*60*60*1000)) : ""; return s.dob ? `${s.dob.replace(/-/g, "/")} (${age})` : ""; }},
        nationality: { header: "国籍\nNationality", width: 14, val: (s) => s.nationality || "Bangladeshi" },
        education: { header: "最終学歴\nEducation", width: 22, val: (s, _, edu) => edu.level || "Honours" },
        gpa: { header: "GPA", width: 12, val: (s, _, edu) => edu.gpa ? `${edu.gpa}(4.00)` : "" },
        jp_level: { header: "日本語能力\nJP Level/Score", width: 22, val: (s, _, __, jp) => jp.level ? `${jp.exam_type || "JLPT"} ${jp.level}${jp.score ? "/" + jp.score : ""}` : "" },
        jp_study_hours: { header: "日本語学習時間\nJP Study Hours", width: 28, val: () => "Approx. 150 hours 大概150個小時" },
        occupation: { header: "職業\nOccupation", width: 12, val: () => "Student" },
        past_visa: { header: "過去入管申請歴\nPast Immigration", width: 28, val: () => "無し" },
        sponsor: { header: "経費支弁者\nSponsor (Income)", width: 28, val: (s, _, __, ___, sp) => sp.annual_income_y1 ? Number(sp.annual_income_y1).toLocaleString("en-IN") : "" },
        sponsor_relation: { header: "フジ\n記入欄", width: 12, val: (s, _, __, ___, sp) => sp.relationship || "Father" },
        passport_no: { header: "Passport No", width: 15, val: (s) => s.passport_number || "" },
        phone: { header: "Phone", width: 15, val: (s) => s.phone || "" },
        email: { header: "Email", width: 22, val: (s) => s.email || "" },
        address: { header: "Address", width: 30, val: (s) => s.permanent_address || "" },
        intended_semester: { header: "Intended Semester", width: 18, val: (s) => s.intake || "" },
        coe_applied: { header: "COE Applied?", width: 12, val: (s) => s.status === "COE_RECEIVED" ? "Yes" : "No" },
        textbook_lesson: { header: "Textbook Lesson", width: 10, val: () => "25" },
        goal: { header: "卒業後の方向\nGoal", width: 25, val: () => "Return to home country　帰国" },
      };

      // Use selected columns, or default all
      const activeCols = (columns.length > 0 ? columns : Object.keys(COL_CONFIG)).filter(k => COL_CONFIG[k]);

      // Header row 1: Agency info
      ws.mergeCells(1, 1, 1, activeCols.length);
      ws.getCell("A1").value = `行名(Agent Name):　${agency_name || ""}${staff_name ? `　　担当者: ${staff_name}` : ""}`;
      ws.getCell("A1").font = { bold: true, size: 14 };

      // Header row 3: Column headers
      const headerRow = ws.getRow(3);
      activeCols.forEach((key, i) => {
        const cfg = COL_CONFIG[key];
        const cell = headerRow.getCell(i + 1);
        cell.value = cfg.header;
        cell.font = { bold: true, size: 9 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
        ws.getColumn(i + 1).width = cfg.width;
      });
      headerRow.height = 50;

      // Student data rows (starting from row 4)
      students.forEach((stu, idx) => {
        const s = decryptSensitiveFields(stu);
        const dd = docDataMap[s.id] || {};
        const edu = (s.student_education || []).sort((a, b) => (b.year || 0) - (a.year || 0))[0] || {};
        const jp = (s.student_jp_exams || [])[0] || {};
        const sp = (s.sponsors || [])[0] || {};

        // Dynamic columns — selected columns only
        const row = ws.getRow(4 + idx);
        activeCols.forEach((key, i) => {
          const cfg = COL_CONFIG[key];
          const cell = row.getCell(i + 1);
          cell.value = cfg.val(s, idx, edu, jp, sp);
          cell.font = { size: 10 };
          cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
        });
      });

      // Column widths
      [6, 18, 18, 8, 22, 22, 18, 28, 28, 28, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    }

    // Send xlsx
    const schoolName = (school.name_en || "school").replace(/[^a-zA-Z0-9_\- ]/g, "");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Interview_List_${schoolName}_${students.length}students.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
