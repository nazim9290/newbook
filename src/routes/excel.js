const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// File upload config
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../uploads"),
  filename: (req, file, cb) => cb(null, `template_${Date.now()}_${file.originalname}`),
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
router.post("/upload-template", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ফাইল আপলোড করুন" });

    const { school_name } = req.body;
    if (!school_name) return res.status(400).json({ error: "স্কুলের নাম দিন" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    // Extract ALL cells that have text — each one is a potential mapping target
    const allCells = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const value = getCellText(cell);
          if (value) {
            allCells.push({
              sheet: sheet.name,
              cell: `${colLetter(colNumber)}${rowNumber}`,
              row: rowNumber,
              col: colNumber,
              label: value,
            });
          }
        });
      });
    });

    // Smart detection: find paired cells (label + value)
    // Pattern 1: Same text appears in adjacent columns (A3: 名前, B3: 名前) → B3 is where data goes
    // Pattern 2: Label in A, empty B → B is where data goes
    // Pattern 3: Single label → the cell itself will be replaced
    const mappingSuggestions = detectMappings(allCells, workbook);

    // Save template record
    const { data: tmpl, error } = await supabase
      .from("excel_templates")
      .insert({
        agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
        school_name,
        file_name: req.file.originalname,
        template_url: req.file.path,
        mappings: [],
        total_fields: mappingSuggestions.length,
        mapped_fields: 0,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      template: tmpl,
      sheets: workbook.worksheets.map((s) => s.name),
      allCells,
      mappingSuggestions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// GET /api/excel/templates
// ================================================================
router.get("/templates", async (req, res) => {
  const { data, error } = await supabase
    .from("excel_templates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ================================================================
// GET /api/excel/templates/:id
// ================================================================
router.get("/templates/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("excel_templates")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
  res.json(data);
});

// ================================================================
// POST /api/excel/templates/:id/mapping
// Body: { mappings: [{ cell: "B3", label: "名前", field: "name_en", targetCell: "B3" }, ...] }
// ================================================================
router.post("/templates/:id/mapping", async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: "mappings array দিন" });

  const mapped = mappings.filter((m) => m.field && m.field.trim());

  const { data, error } = await supabase
    .from("excel_templates")
    .update({ mappings, mapped_fields: mapped.length, total_fields: mappings.length })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ================================================================
// POST /api/excel/generate
// Body: { template_id, student_ids: ["S-001", ...] }
// Returns: .xlsx file (exact copy of template with data filled)
// ================================================================
router.post("/generate", async (req, res) => {
  try {
    const { template_id, student_ids } = req.body;
    if (!template_id) return res.status(400).json({ error: "template_id দিন" });
    if (!student_ids || !student_ids.length) return res.status(400).json({ error: "student_ids দিন" });

    // Get template
    const { data: tmpl, error: tErr } = await supabase
      .from("excel_templates")
      .select("*")
      .eq("id", template_id)
      .single();
    if (tErr) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
    if (!tmpl.mappings || !tmpl.mappings.length) return res.status(400).json({ error: "কোনো mapping নেই" });

    // Get students
    const { data: students, error: sErr } = await supabase
      .from("students")
      .select("*, student_education(*), student_jp_exams(*), student_family(*), sponsors(*)")
      .in("id", student_ids);
    if (sErr) return res.status(500).json({ error: sErr.message });

    const templatePath = tmpl.template_url;

    // No physical template → CSV fallback
    if (!templatePath || !fs.existsSync(templatePath)) {
      return generateCSV(res, tmpl, students);
    }

    if (students.length === 1) {
      // Single student: read template → fill ALL sheets → send
      // This preserves the EXACT original format with all sheets intact
      const buffer = await fillSingleStudent(templatePath, tmpl.mappings, students[0]);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(students[0].name_en || students[0].id)}.xlsx"`);
      res.send(buffer);
    } else {
      // Multiple students: each gets their own COMPLETE copy of the template
      // Output: one .xlsx per student, but we pack them as separate files
      // For simplicity: generate first student as primary download
      // Better approach: generate each separately with fillSingleStudent
      const buffer = await fillSingleStudent(templatePath, tmpl.mappings, students[0]);

      // For bulk: return a zip or let frontend call one-by-one
      // Here we return first student + metadata for others
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(students[0].name_en || students[0].id)}.xlsx"`);
      res.setHeader("X-Total-Students", students.length);
      res.setHeader("X-Generated-For", students[0].name_en || students[0].id);
      res.send(buffer);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// POST /api/excel/generate-single
// Body: { template_id, student_id }
// For bulk: frontend calls this once per student
// ================================================================
router.post("/generate-single", async (req, res) => {
  try {
    const { template_id, student_id } = req.body;
    if (!template_id || !student_id) return res.status(400).json({ error: "template_id ও student_id দিন" });

    const { data: tmpl } = await supabase.from("excel_templates").select("*").eq("id", template_id).single();
    if (!tmpl) return res.status(404).json({ error: "Template পাওয়া যায়নি" });

    const { data: student } = await supabase
      .from("students")
      .select("*, student_education(*), student_jp_exams(*), student_family(*), sponsors(*)")
      .eq("id", student_id)
      .single();
    if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

    if (!tmpl.template_url || !fs.existsSync(tmpl.template_url)) {
      return generateCSV(res, tmpl, [student]);
    }

    const buffer = await fillSingleStudent(tmpl.template_url, tmpl.mappings, student);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${encName(tmpl.school_name)}_${encName(student.name_en || student.id)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// POST /api/excel/re-parse/:id
// ================================================================
router.post("/re-parse/:id", async (req, res) => {
  try {
    const { data: tmpl, error } = await supabase
      .from("excel_templates")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error) return res.status(404).json({ error: "Template পাওয়া যায়নি" });
    if (!tmpl.template_url || !fs.existsSync(tmpl.template_url)) {
      return res.status(400).json({ error: "Template ফাইল পাওয়া যায়নি" });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tmpl.template_url);

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
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DELETE /api/excel/templates/:id
// ================================================================
router.delete("/templates/:id", async (req, res) => {
  const { data: tmpl } = await supabase.from("excel_templates").select("template_url").eq("id", req.params.id).single();
  if (tmpl && tmpl.template_url && fs.existsSync(tmpl.template_url)) fs.unlinkSync(tmpl.template_url);
  const { error } = await supabase.from("excel_templates").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ================================================================
// GET /api/excel/system-fields
// ================================================================
router.get("/system-fields", (req, res) => res.json(SYSTEM_FIELDS));

// ================================================================
// HELPERS
// ================================================================

function colLetter(col) {
  let s = "";
  while (col > 0) { col--; s = String.fromCharCode(65 + (col % 26)) + s; col = Math.floor(col / 26); }
  return s;
}

function getCellText(cell) {
  if (!cell) return "";
  const v = cell.text || (cell.value && typeof cell.value === "object" ? cell.value.result || "" : cell.value);
  return typeof v === "string" ? v.trim() : v ? String(v).trim() : "";
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

// Fill a single student into a fresh copy of the template — ALL sheets
async function fillSingleStudent(templatePath, mappings, student) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

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

// Fill mapped data into a sheet — handles merged cells
function fillSheetData(sheet, mappings, student) {
  const flat = flattenStudent(student);
  for (const m of mappings) {
    if (!m.field || !m.cell) continue;
    const value = flat[m.field] || "";
    if (!value) continue;
    try {
      const cell = sheet.getCell(m.cell);
      // Preserve style, font, border — only change value
      const oldStyle = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
      cell.value = value;
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
function flattenStudent(s) {
  const flat = {};
  const fields = [
    "id", "name_en", "name_bn", "name_katakana", "phone", "whatsapp", "email",
    "dob", "gender", "marital_status", "nationality", "blood_group",
    "nid", "passport_number", "passport_issue", "passport_expiry",
    "permanent_address", "current_address",
    "father_name", "father_name_en", "mother_name", "mother_name_en",
    "country", "intake", "visa_type", "source", "student_type", "status", "branch",
  ];
  for (const f of fields) flat[f] = s[f] || "";

  // Age
  if (s.dob) {
    const birth = new Date(s.dob);
    flat.age = String(new Date().getFullYear() - birth.getFullYear());
  }

  // Education
  if (Array.isArray(s.student_education)) {
    for (const edu of s.student_education) {
      const key = (edu.level || "").toLowerCase().replace(/[^a-z]/g, "");
      const match = ["ssc", "hsc", "honours", "masters", "diploma"].find((l) => key.includes(l)) || key.substring(0, 6);
      flat[`edu_${match}_school`] = edu.school_name || "";
      flat[`edu_${match}_year`] = edu.year || "";
      flat[`edu_${match}_board`] = edu.board || "";
      flat[`edu_${match}_gpa`] = edu.gpa || "";
      flat[`edu_${match}_subject`] = edu.subject_group || "";
    }
  }

  // JP exams
  if (Array.isArray(s.student_jp_exams) && s.student_jp_exams.length > 0) {
    const latest = [...s.student_jp_exams].sort((a, b) => (b.exam_date || "").localeCompare(a.exam_date || ""))[0];
    flat.jp_exam_type = latest.exam_type || "";
    flat.jp_level = latest.level || "";
    flat.jp_score = String(latest.score || "");
    flat.jp_result = latest.result || "";
    flat.jp_exam_date = latest.exam_date || "";
  }

  // Family
  if (Array.isArray(s.student_family)) {
    for (const f of s.student_family) {
      const rel = (f.relation || "").toLowerCase();
      flat[`${rel}_name`] = f.name || "";
      flat[`${rel}_name_en`] = f.name_en || "";
      flat[`${rel}_dob`] = f.dob || "";
      flat[`${rel}_occupation`] = f.occupation || "";
      flat[`${rel}_workplace`] = f.workplace || "";
      flat[`${rel}_phone`] = f.phone || "";
    }
  }

  // Sponsor
  if (Array.isArray(s.sponsors) && s.sponsors.length > 0) {
    const sp = s.sponsors[0];
    flat.sponsor_name = sp.name || "";
    flat.sponsor_name_en = sp.name_en || "";
    flat.sponsor_relationship = sp.relationship || "";
    flat.sponsor_phone = sp.phone || "";
    flat.sponsor_address = sp.address || "";
    flat.sponsor_company = sp.company_name || "";
    flat.sponsor_income_y1 = String(sp.annual_income_y1 || "");
    flat.sponsor_income_y2 = String(sp.annual_income_y2 || "");
    flat.sponsor_income_y3 = String(sp.annual_income_y3 || "");
    flat.sponsor_tax_y1 = String(sp.tax_y1 || "");
    flat.sponsor_tax_y2 = String(sp.tax_y2 || "");
    flat.sponsor_tax_y3 = String(sp.tax_y3 || "");
  }

  return flat;
}

// System fields for frontend
const SYSTEM_FIELDS = [
  { group: "ব্যক্তিগত", fields: [
    { key: "name_en", label: "নাম (English)" }, { key: "name_bn", label: "নাম (বাংলা)" },
    { key: "name_katakana", label: "নাম (カタカナ)" }, { key: "dob", label: "জন্ম তারিখ" },
    { key: "age", label: "বয়স" }, { key: "gender", label: "লিঙ্গ" },
    { key: "marital_status", label: "বৈবাহিক অবস্থা" }, { key: "nationality", label: "জাতীয়তা" },
    { key: "blood_group", label: "রক্তের গ্রুপ" }, { key: "phone", label: "ফোন" },
    { key: "whatsapp", label: "WhatsApp" }, { key: "email", label: "ইমেইল" },
  ]},
  { group: "পাসপোর্ট / NID", fields: [
    { key: "nid", label: "NID নম্বর" }, { key: "passport_number", label: "পাসপোর্ট নম্বর" },
    { key: "passport_issue", label: "পাসপোর্ট ইস্যু" }, { key: "passport_expiry", label: "পাসপোর্ট মেয়াদ" },
  ]},
  { group: "ঠিকানা", fields: [
    { key: "permanent_address", label: "স্থায়ী ঠিকানা" }, { key: "current_address", label: "বর্তমান ঠিকানা" },
  ]},
  { group: "পরিবার", fields: [
    { key: "father_name", label: "পিতার নাম (বাংলা)" }, { key: "father_name_en", label: "পিতার নাম (EN)" },
    { key: "mother_name", label: "মাতার নাম (বাংলা)" }, { key: "mother_name_en", label: "মাতার নাম (EN)" },
    { key: "father_dob", label: "পিতার জন্ম তারিখ" }, { key: "father_occupation", label: "পিতার পেশা" },
    { key: "mother_dob", label: "মাতার জন্ম তারিখ" }, { key: "mother_occupation", label: "মাতার পেশা" },
    { key: "father_phone", label: "পিতার ফোন" }, { key: "mother_phone", label: "মাতার ফোন" },
    { key: "spouse_name", label: "স্বামী/স্ত্রীর নাম" },
  ]},
  { group: "শিক্ষা", fields: [
    { key: "edu_ssc_school", label: "SSC স্কুল" }, { key: "edu_ssc_year", label: "SSC সন" },
    { key: "edu_ssc_board", label: "SSC বোর্ড" }, { key: "edu_ssc_gpa", label: "SSC GPA" },
    { key: "edu_ssc_subject", label: "SSC বিভাগ" },
    { key: "edu_hsc_school", label: "HSC কলেজ" }, { key: "edu_hsc_year", label: "HSC সন" },
    { key: "edu_hsc_board", label: "HSC বোর্ড" }, { key: "edu_hsc_gpa", label: "HSC GPA" },
    { key: "edu_hsc_subject", label: "HSC বিভাগ" },
    { key: "edu_honours_school", label: "Honours বিশ্ববিদ্যালয়" }, { key: "edu_honours_year", label: "Honours সন" },
    { key: "edu_honours_gpa", label: "Honours GPA" }, { key: "edu_honours_subject", label: "Honours বিষয়" },
  ]},
  { group: "জাপানি ভাষা", fields: [
    { key: "jp_exam_type", label: "পরীক্ষার ধরন" }, { key: "jp_level", label: "লেভেল" },
    { key: "jp_score", label: "স্কোর" }, { key: "jp_result", label: "ফলাফল" }, { key: "jp_exam_date", label: "পরীক্ষার তারিখ" },
  ]},
  { group: "স্পন্সর", fields: [
    { key: "sponsor_name", label: "স্পন্সরের নাম" }, { key: "sponsor_name_en", label: "স্পন্সর নাম (EN)" },
    { key: "sponsor_relationship", label: "সম্পর্ক" }, { key: "sponsor_phone", label: "স্পন্সর ফোন" },
    { key: "sponsor_address", label: "স্পন্সর ঠিকানা" }, { key: "sponsor_company", label: "কোম্পানি" },
    { key: "sponsor_income_y1", label: "আয় (১ম বছর)" }, { key: "sponsor_income_y2", label: "আয় (২য় বছর)" },
    { key: "sponsor_income_y3", label: "আয় (৩য় বছর)" },
    { key: "sponsor_tax_y1", label: "ট্যাক্স (১ম বছর)" }, { key: "sponsor_tax_y2", label: "ট্যাক্স (২য় বছর)" },
    { key: "sponsor_tax_y3", label: "ট্যাক্স (৩য় বছর)" },
  ]},
  { group: "গন্তব্য", fields: [
    { key: "country", label: "দেশ" }, { key: "intake", label: "Intake" },
    { key: "visa_type", label: "ভিসার ধরন" }, { key: "student_type", label: "স্টুডেন্ট টাইপ" },
  ]},
];

module.exports = router;
