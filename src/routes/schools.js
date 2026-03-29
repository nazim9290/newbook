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

// POST /api/schools/:id/interview-list — Excel download
router.post("/:id/interview-list", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { student_ids, format, agency_name, staff_name, columns } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return res.status(400).json({ error: "student_ids দিন" });
  }

  // Students data fetch
  const students = [];
  for (const sid of student_ids) {
    const { data } = await supabase.from("students").select("*").eq("id", sid).single();
    if (data) students.push(data);
  }

  // School info
  const { data: school } = await supabase.from("schools").select("*").eq("id", req.params.id).single();

  // ExcelJS দিয়ে .xlsx generate
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Interview List");

  // Header info
  ws.addRow(["Agency", agency_name || "AgencyBook"]);
  ws.addRow(["School", school?.name_en || ""]);
  ws.addRow(["Staff", staff_name || ""]);
  ws.addRow(["Date", new Date().toISOString().slice(0, 10)]);
  ws.addRow([]);

  // Column headers
  const COL_MAP = {
    serial: "ক্রমিক", passport: "পাসপোর্ট নং", name: "নাম", gender: "লিঙ্গ",
    dob: "জন্ম তারিখ (বয়স)", nationality: "জাতীয়তা", guardian: "অভিভাবকের যোগাযোগ",
    jlpt: "জেএলপিটি", gpa_ssc: "জেপি লেভেল/স্কোর", phone: "ফোন", email: "ইমেইল",
    address: "ঠিকানা", intake: "ইনটেক সেমিস্টার", coe: "COE আবেদন?",
    visa_interview_date: "সাইবারনাইফ পার্ট", sponsor: "স্পন্সর (আয়)", sponsor_contact: "স্পন্সর যোগাযোগ",
    plan_after: "পড়াশোনার পর পরিকল্পনা",
  };
  const activeCols = (columns || Object.keys(COL_MAP)).filter(c => COL_MAP[c]);
  const headerRow = ws.addRow(activeCols.map(c => COL_MAP[c] || c));
  headerRow.font = { bold: true };
  headerRow.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF22D3EE" } }; cell.font = { bold: true, color: { argb: "FF000000" } }; });

  // Student rows
  students.forEach((s, i) => {
    const row = {};
    row.serial = i + 1;
    row.passport = s.passport_number || "";
    row.name = s.name_en || "";
    row.gender = s.gender || "";
    row.dob = s.dob || "";
    row.nationality = s.nationality || "Bangladeshi";
    row.guardian = "";
    row.jlpt = "";
    row.gpa_ssc = "";
    row.phone = s.phone || "";
    row.email = s.email || "";
    row.address = s.permanent_address || "";
    row.intake = s.intake || "";
    row.coe = "";
    row.visa_interview_date = "";
    row.sponsor = "";
    row.sponsor_contact = "";
    row.plan_after = "";
    ws.addRow(activeCols.map(c => row[c] || ""));
  });

  // Auto-width
  ws.columns.forEach(col => { col.width = 18; });

  // Send as xlsx
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Interview_List.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
