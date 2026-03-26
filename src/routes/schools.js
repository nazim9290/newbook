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
    const { student_ids, format = "row", agency_name = "" } = req.body;
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
      // ═══ Row-wise: each student = one row ═══
      const ws = wb.addWorksheet("Student List");

      // Header row 1: Agency info
      ws.mergeCells("A1:L1");
      ws.getCell("A1").value = `行名(Agent Name):　${agency_name || ""}`;
      ws.getCell("A1").font = { bold: true, size: 14 };

      // Header row 3: Column headers
      const headers = [
        "No.", "氏 Sir Name\n(Family Name)", "名 Given Name\n(First Name)",
        "性別\nGender\n(M/F)", "生年月日(年齢)\nDate of Birth(Age)",
        "最終学歴\nLast School Attended\n(Academic Background)",
        "高校 or 大学GPA\nHigh School GPA\nUniversity GPA",
        "現時点での日本語学習時間\nCurrent Studying Time of\nJapanese Language",
        "過去入管申請歴\nPast Applications to Japanese\nImmigration Office",
        "経費支弁者\nSponsor\n(Most recent annual income)",
        "フジ\n記入欄",
      ];

      const headerRow = ws.getRow(3);
      headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 9 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
      });
      headerRow.height = 50;

      // Example row 4
      const exRow = ws.getRow(4);
      ["ex", "", "", "Male", "2000/1/1 (22)", "University Graduated", "4.00", "JLPT N5 or NAT 5級", "None", "Father (3,500,000.00 BDT)", "Father"].forEach((v, i) => {
        exRow.getCell(i + 1).value = v;
        exRow.getCell(i + 1).font = { italic: true, size: 9, color: { argb: "FF666666" } };
        exRow.getCell(i + 1).border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
      });

      // Student data rows
      students.forEach((stu, idx) => {
        const s = decryptSensitiveFields(stu);
        const dd = docDataMap[s.id] || {};
        const edu = (s.student_education || []).sort((a, b) => (b.year || 0) - (a.year || 0))[0] || {};
        const jp = (s.student_jp_exams || [])[0] || {};
        const sp = (s.sponsors || [])[0] || {};

        const nameParts = (s.name_en || "").trim().split(/\s+/);
        const familyName = nameParts[0] || "";
        const givenName = nameParts.slice(1).join(" ") || "";

        const age = s.dob ? Math.floor((Date.now() - new Date(s.dob)) / (365.25 * 24 * 60 * 60 * 1000)) : "";
        const dobFormatted = s.dob ? s.dob.replace(/-/g, "/") : "";

        const row = ws.getRow(5 + idx);
        const vals = [
          idx + 1,
          familyName,
          givenName,
          s.gender === "Male" ? "Male" : s.gender === "Female" ? "Female" : s.gender || "",
          age ? `${dobFormatted} (${age})` : dobFormatted,
          edu.level || "Honours",
          edu.gpa ? `${edu.gpa}(4.00)` : "",
          jp.level ? `${jp.exam_type || "JLPT"} ${jp.level}` : "",
          "無し",
          sp.annual_income_y1 ? `${Number(sp.annual_income_y1).toLocaleString("en-IN")}` : "",
          sp.relationship || "Father",
        ];

        vals.forEach((v, i) => {
          const cell = row.getCell(i + 1);
          cell.value = v;
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
