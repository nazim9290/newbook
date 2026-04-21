/**
 * import.js — Excel bulk import routes
 *
 * GET  /import/template      — Download .xlsx template (headers + guide + sample)
 * POST /import               — Bulk import with pre-mapped rows (JSON body)
 * POST /import/parse         — Upload Excel → return headers + preview + auto-mapping suggestions
 * POST /import/mapped        — Upload Excel + mapping JSON → bulk student create
 */

const express = require("express");
const ExcelJS = require("exceljs");
const fs = require("fs");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { encryptSensitiveFields } = require("../../lib/crypto");
const { checkPermission } = require("../../middleware/checkPermission");
const { generateId } = require("../../lib/idGenerator");
const cache = require("../../lib/cache");
const { STUDENT_COLUMNS, importUpload } = require("./_shared");

const router = express.Router();
router.use(auth);

// ================================================================
// GET /api/students/import/template — Import template (.xlsx) download
// Phone, NID, WhatsApp column Text format — leading zero রক্ষা
// ================================================================
router.get("/import/template", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students");

  // ── সব student ফিল্ড — ইউজার bulk import করতে পারবে ──
  const cols = [
    // ── Personal Info ──
    { header: "Full Name (English) *", key: "name_en", width: 28 },
    { header: "Name (カタカナ)", key: "name_katakana", width: 20 },
    { header: "Phone *", key: "phone", width: 18 },
    { header: "WhatsApp", key: "whatsapp", width: 18 },
    { header: "Email", key: "email", width: 24 },
    { header: "Date of Birth", key: "dob", width: 14 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Marital Status", key: "marital_status", width: 12 },
    { header: "Nationality", key: "nationality", width: 14 },
    { header: "Blood Group", key: "blood_group", width: 10 },
    { header: "Place of Birth", key: "birth_place", width: 18 },
    { header: "Occupation", key: "occupation", width: 15 },
    // ── Passport & NID ──
    { header: "NID", key: "nid", width: 20 },
    { header: "Passport No", key: "passport_number", width: 15 },
    { header: "Passport Issue Date", key: "passport_issue", width: 14 },
    { header: "Passport Expiry Date", key: "passport_expiry", width: 14 },
    // ── Address ──
    { header: "Permanent Address", key: "permanent_address", width: 35 },
    { header: "Current Address", key: "current_address", width: 35 },
    // ── Family ──
    { header: "Father Name", key: "father_name", width: 22 },
    { header: "Mother Name", key: "mother_name", width: 22 },
    { header: "Spouse Name", key: "spouse_name", width: 20 },
    { header: "Emergency Contact", key: "emergency_contact", width: 20 },
    { header: "Emergency Phone", key: "emergency_phone", width: 18 },
    // ── Destination & Status ──
    { header: "Country", key: "country", width: 12 },
    { header: "School", key: "school", width: 25 },
    { header: "Batch", key: "batch", width: 15 },
    { header: "Intake", key: "intake", width: 15 },
    { header: "Visa Type", key: "visa_type", width: 18 },
    { header: "Student Type", key: "student_type", width: 12 },
    { header: "Branch", key: "branch", width: 12 },
    { header: "Source", key: "source", width: 14 },
    { header: "Counselor", key: "counselor", width: 15 },
    // ── Study Plan ──
    { header: "Reason for Study", key: "reason_for_study", width: 30 },
    { header: "Future Plan", key: "future_plan", width: 25 },
    { header: "Study Subject", key: "study_subject", width: 20 },
  ];
  ws.columns = cols;

  // Header row style — cyan background, white bold text
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF06B6D4" } };
  headerRow.alignment = { horizontal: "center" };

  // Required columns (* চিহ্নিত) red background — Name (1) ও Phone (3)
  [1, 3].forEach(col => {
    const cell = headerRow.getCell(col);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF43F5E" } };
  });

  // ── Row 2 = নির্দেশনা সারি — প্রতিটি ফিল্ডের জন্য hint ──
  const guideRow = ws.addRow([
    "Required — Full name in English CAPS", "カタカナ name", "Required — 01XXXXXXXXX",
    "If different from phone", "Optional", "YYYY-MM-DD", "Male / Female / Other",
    "Single / Married / Divorced", "Bangladeshi", "A+ / B+ / O+ / AB+ etc.",
    "Place of birth", "Student / Business etc.",
    "17-digit NID number", "Passport number", "YYYY-MM-DD", "YYYY-MM-DD",
    "Village, Upazila, District", "Current address if different",
    "Father full name", "Mother full name", "Spouse name", "Emergency person name", "Emergency phone",
    "Japan / Germany / Korea", "School name", "e.g. April 2026", "e.g. April 2026",
    "Language Student / SSW / TITP", "Own / Partner", "Main / Chattogram / Sylhet",
    "Facebook / Walk-in / Agent / Referral", "Counselor name",
    "Reason for studying abroad", "Future career plan", "Subject of study",
  ]);
  guideRow.font = { italic: true, size: 9, color: { argb: "FF666666" } };
  guideRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFDE7" } };

  // ── Row 3 = Sample data ──
  ws.addRow([
    "MOHAMMAD RAHIM", "モハマド ラヒム", "01811111111",
    "01811111111", "rahim@gmail.com", "1998-03-12", "Male",
    "Single", "Bangladeshi", "B+", "Comilla", "Student",
    "1998123456789", "BK1234567", "2020-01-15", "2030-01-14",
    "Comilla, Bangladesh", "", "Abdul Karim", "Fatema Begum",
    "", "", "",
    "Japan", "Kobe Japanese Language School", "April 2026", "April 2026",
    "Language Student", "Own", "Main", "Facebook", "Mina",
    "To learn Japanese and work in Japan", "IT engineer in Japan", "Computer Science",
  ]);

  // ── Phone, NID, WhatsApp, Emergency Phone → Text format (leading zero রক্ষা) ──
  const textCols = [3, 4, 13, 23]; // phone, whatsapp, nid, emergency_phone
  for (let r = 1; r <= 200; r++) {
    textCols.forEach(c => {
      ws.getCell(r, c).numFmt = "@";
    });
  }

  // Send as .xlsx
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="AgencyBook_Student_Import_Template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

// ================================================================
// POST /api/students/import — Excel থেকে bulk student import
// Body: { students: [{ name_en, phone, dob, ... }, ...] }
// Frontend Excel parse করে mapped data পাঠায়
// ================================================================
router.post("/import", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { students: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "কোনো student data পাওয়া যায়নি" });
  }

  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
  const results = { success: 0, failed: 0, errors: [] };

  // প্রতিটি row-কে valid student record-এ convert
  const records = rows.map((row, idx) => {
    const year = new Date().getFullYear();
    const seq = String(idx + 1).padStart(3, "0");
    const record = { agency_id: agencyId, id: row.id || `S-${year}-IMP${seq}` };
    for (const col of STUDENT_COLUMNS) {
      if (col === "id") continue;
      if (row[col] !== undefined && row[col] !== null && row[col] !== "") {
        record[col] = row[col];
      }
    }
    if (!record.passport_number && row.passport) record.passport_number = row.passport;
    if (!record.father_name && row.father) record.father_name = row.father;
    if (!record.mother_name && row.mother) record.mother_name = row.mother;
    if (!record.name_en) record.name_en = row.name || row.full_name || row.student_name || `Student ${idx + 1}`;
    if (!record.status) record.status = "ENROLLED";
    return encryptSensitiveFields(record);
  });

  // Batch insert — Supabase supports bulk insert
  const { data, error } = await supabase
    .from("students")
    .insert(records)
    .select();

  if (error) {
    // Bulk fail → try one by one
    for (let i = 0; i < records.length; i++) {
      const { error: sErr } = await supabase.from("students").insert(records[i]).select();
      if (sErr) {
        results.failed++;
        results.errors.push({ row: i + 1, name: rows[i].name_en || rows[i].name || `Row ${i + 1}`, error: "ডাটা সংরক্ষণ ব্যর্থ" });
      } else {
        results.success++;
      }
    }
  } else {
    results.success = data.length;
  }

  // ক্যাশ invalidate — bulk import এ student count বদলায়
  if (results.success > 0) cache.invalidate(agencyId);

  res.json({
    message: `${results.success} জন import সফল, ${results.failed} জন ব্যর্থ`,
    ...results,
    total: rows.length,
  });
}));

// ================================================================
// POST /api/students/import/parse — Excel file parse করে columns return
// ================================================================
router.post("/import/parse", checkPermission("students", "write"), importUpload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Excel ফাইল দিন" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: "কোনো sheet পাওয়া যায়নি" });

    // প্রথম row = headers
    const headers = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = cell.text || (cell.value != null ? String(cell.value) : "");
      headers.push({ col: colNumber, name: val.trim() });
    });

    // ── Data rows — empty row skip করো, max 5 preview ──
    const preview = [];
    let dataRowCount = 0;
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      // row-তে কোনো data আছে কিনা চেক করো
      let hasData = false;
      headers.forEach(h => {
        const cell = row.getCell(h.col);
        const val = cell.text || (cell.value != null ? String(cell.value).trim() : "");
        if (val) hasData = true;
      });
      if (!hasData) continue;
      // Guide/sample row skip — hint text বা sample name detect
      const rowVals = [];
      headers.forEach(h => { const c = row.getCell(h.col); rowVals.push(c.text || (c.value != null ? String(c.value) : "")); });
      const rowText = rowVals.join(" ");
      if (/YYYY-MM-DD|বাধ্যতামূলক|Required —|placeholder|FULL NAME IN CAPS|01XXXXXXXXX format/i.test(rowText)) continue;
      dataRowCount++;
      if (preview.length < 5) {
        const obj = {};
        headers.forEach(h => {
          const cell = row.getCell(h.col);
          obj[h.name] = cell.text || (cell.value != null ? String(cell.value) : "");
        });
        preview.push(obj);
      }
    }

    // Auto-suggest mappings
    const suggestions = {};
    // ── Auto-mapping — Excel header text → system field ──
    const autoMap = {
      // Personal
      "name": "name_en", "নাম": "name_en", "full name": "name_en", "student name": "name_en",
      "katakana": "name_katakana", "カタカナ": "name_katakana",
      "phone": "phone", "ফোন": "phone", "mobile": "phone", "contact": "phone",
      "whatsapp": "whatsapp",
      "email": "email", "ইমেইল": "email",
      "dob": "dob", "date of birth": "dob", "জন্ম তারিখ": "dob", "birth date": "dob",
      "gender": "gender", "লিঙ্গ": "gender", "sex": "gender",
      "marital": "marital_status", "বৈবাহিক": "marital_status",
      "nationality": "nationality", "জাতীয়তা": "nationality",
      "blood": "blood_group", "রক্ত": "blood_group",
      "birth place": "birth_place", "place of birth": "birth_place", "জন্মস্থান": "birth_place",
      "occupation": "occupation", "পেশা": "occupation",
      // Passport & NID
      "nid": "nid", "national id": "nid",
      "passport": "passport_number", "পাসপোর্ট": "passport_number",
      "passport issue": "passport_issue",
      "passport expiry": "passport_expiry",
      // Address
      "permanent address": "permanent_address", "address": "permanent_address", "ঠিকানা": "permanent_address",
      "current address": "current_address",
      // Family
      "father": "father_name", "পিতা": "father_name", "father name": "father_name",
      "mother": "mother_name", "মাতা": "mother_name", "mother name": "mother_name",
      "spouse": "spouse_name", "স্বামী": "spouse_name", "স্ত্রী": "spouse_name",
      "emergency contact": "emergency_contact",
      "emergency phone": "emergency_phone",
      // Destination
      "country": "country", "দেশ": "country",
      "school": "school", "স্কুল": "school",
      "batch": "batch", "ব্যাচ": "batch",
      "intake": "intake",
      "visa type": "visa_type", "visa": "visa_type",
      "student type": "student_type", "type": "student_type",
      "branch": "branch", "ব্রাঞ্চ": "branch",
      "source": "source",
      "counselor": "counselor", "কাউন্সেলর": "counselor",
      // Study Plan
      "reason": "reason_for_study",
      "future plan": "future_plan",
      "study subject": "study_subject", "subject": "study_subject",
      "status": "status",
    };
    headers.forEach(h => {
      const lower = h.name.toLowerCase();
      for (const [key, field] of Object.entries(autoMap)) {
        if (lower.includes(key)) { suggestions[h.name] = field; break; }
      }
    });

    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}

    res.json({
      headers: headers.map(h => h.name),
      totalRows: dataRowCount,
      preview,
      suggestions,
    });
  } catch (err) {
    console.error("Import parse error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/students/import/mapped — Excel + mapping → bulk import
// FormData: file + mapping JSON
// ================================================================
router.post("/import/mapped", checkPermission("students", "write"), importUpload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Excel ফাইল দিন" });
    const mapping = JSON.parse(req.body.mapping || "{}");
    if (Object.keys(mapping).length === 0) return res.status(400).json({ error: "Mapping দিন" });

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];

    // Headers from row 1
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const val = cell.text || (cell.value != null ? String(cell.value) : "");
      headers.push({ col, name: val.trim() });
    });

    // Build student records from all data rows
    // ── Row 2 = Guide/hint row, Row 3 = Sample data — skip detect ──
    // Template-এর guide row (italic, hint text) ও sample row ("Mohammad Rahim") skip
    const records = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const student = { agency_id: agencyId, status: "ENROLLED" };
      let hasData = false;

      headers.forEach(h => {
        const systemField = mapping[h.name];
        if (!systemField) return;
        const cell = row.getCell(h.col);
        const val = cell.text || (cell.value != null ? String(cell.value).trim() : "");
        if (val) {
          student[systemField] = val;
          hasData = true;
        }
      });

      // ── Guide/hint row skip — শুধু template hint text detect ──
      const allVals = Object.values(student).join(" ");
      const isGuideRow = /YYYY-MM-DD|বাধ্যতামূলক|Required —|placeholder|FULL NAME IN CAPS|01XXXXXXXXX format/i.test(allVals);
      if (hasData && student.name_en && !isGuideRow) {
        // Valid columns only + auto-generate unique ID (timestamp-based)
        const clean = { agency_id: agencyId, id: student.id || await generateId(agencyId, "student") };
        for (const col of STUDENT_COLUMNS) {
          if (col === "id") continue; // already set
          if (student[col] !== undefined && student[col] !== "") clean[col] = student[col];
        }
        if (!clean.status) clean.status = "ENROLLED";
        records.push(encryptSensitiveFields(clean));
      }
    }

    if (records.length === 0) {
      return res.status(400).json({ error: "কোনো valid student data পাওয়া যায়নি — name_en column ম্যাপ করুন" });
    }

    // Bulk insert
    const results = { success: 0, failed: 0, errors: [] };
    const { data, error } = await supabase.from("students").insert(records).select();

    if (error) {
      // Bulk fail → one by one
      console.log("[Import] Bulk insert failed, trying one by one:", error.message);
      for (let i = 0; i < records.length; i++) {
        const { error: sErr } = await supabase.from("students").insert(records[i]);
        if (sErr) {
          console.log(`[Import] Row ${i+2} failed:`, sErr.message);
          results.failed++;
          results.errors.push({ row: i + 2, name: records[i].name_en || `Row ${i + 2}`, error: sErr.message || "ডাটা সংরক্ষণ ব্যর্থ" });
        } else {
          results.success++;
        }
      }
    } else {
      results.success = Array.isArray(data) ? data.length : records.length;
    }

    // Cleanup
    try { fs.unlinkSync(req.file.path); } catch {}

    // ক্যাশ invalidate — mapped import এ student count বদলায়
    if (results.success > 0) cache.invalidate(agencyId);

    res.json({ message: `${results.success} জন student import সফল, ${results.failed} জন ব্যর্থ`, ...results, total: records.length });
  } catch (err) {
    console.error("Import mapped error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

module.exports = router;
