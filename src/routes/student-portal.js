/**
 * student-portal.js — Student Portal API Routes
 *
 * Student নিজে login করে নিজের profile, fees, timeline দেখতে পারে।
 * JWT token-এ type: "student" থাকে — staff token দিয়ে access হবে না।
 *
 * Endpoints:
 *   GET  /me              — নিজের profile
 *   PATCH /me             — profile আপডেট (সীমিত fields)
 *   GET  /form-config     — agency-defined form sections
 *   GET  /fees            — fee items + payments + summary
 *   GET  /payments        — শুধু পেমেন্ট ইতিহাস (বিস্তারিত table-এর জন্য)
 *   GET  /timeline        — pipeline status ও তারিখ
 *   POST /change-password — পাসওয়ার্ড পরিবর্তন
 *   GET  /documents       — student-এর সব ডকুমেন্ট তালিকা
 *   POST /documents/upload — নতুন ডকুমেন্ট আপলোড (multipart/form-data)
 */

const express = require("express");
const path = require("path");
const multer = require("multer");
const supabase = require("../lib/supabase");
const asyncHandler = require("../lib/asyncHandler");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const router = express.Router();

// ── Multer config — student portal document upload ──
const portalDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"), "portal-docs");
    require("fs").mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // student_id + timestamp + original extension
    const ext = path.extname(file.originalname);
    cb(null, `${req.student.student_id}_${Date.now()}${ext}`);
  },
});
const portalDocUpload = multer({
  storage: portalDocStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|pdf|doc|docx)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("শুধু JPG, PNG, WEBP, PDF, DOC, DOCX ফাইল আপলোড করুন"));
  },
});

// ── Student Auth Middleware — JWT token-এ type: "student" চেক ──
const studentAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Token দিন" });
  try {
    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== "student") return res.status(403).json({ error: "Student access only" });
    req.student = decoded;
    next();
  } catch { return res.status(401).json({ error: "Invalid token" }); }
};

router.use(studentAuth);

// ── GET /me — student-এর নিজের profile তথ্য ──
router.get("/me", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("students")
    .select("id, name_en, name_bn, phone, whatsapp, email, dob, gender, marital_status, nationality, blood_group, nid, passport_number, passport_issue, passport_expiry, permanent_address, current_address, father_name, father_name_en, mother_name, mother_name_en, status, country, school, batch, branch, intake, visa_type, photo_url, portal_sections, created_at")
    .eq("id", req.student.student_id).single();
  if (error) return res.status(500).json({ error: "ডাটা লোড ব্যর্থ" });
  res.json(data);
}));

// ── PATCH /me — student নিজের তথ্য আপডেট করতে পারে (সীমিত fields) ──
router.patch("/me", asyncHandler(async (req, res) => {
  // Student যে fields আপডেট করতে পারবে — status, school, batch ইত্যাদি বাদ
  const ALLOWED_FIELDS = [
    "name_en", "name_bn", "phone", "whatsapp", "email",
    "dob", "gender", "marital_status", "nationality", "blood_group",
    "nid", "passport_number", "passport_issue", "passport_expiry",
    "permanent_address", "current_address",
    "father_name", "father_name_en", "mother_name", "mother_name_en",
    "photo_url"
  ];
  const updates = {};
  for (const key of ALLOWED_FIELDS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "কোনো ডাটা দেওয়া হয়নি" });

  const { data, error } = await supabase.from("students").update(updates).eq("id", req.student.student_id).select().single();
  if (error) return res.status(500).json({ error: "আপডেট ব্যর্থ" });
  res.json(data);
}));

// ── GET /form-config — agency কোন sections/forms student-কে দেখাতে চায় ──
router.get("/form-config", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("portal_form_config")
    .select("*")
    .eq("agency_id", req.student.agency_id)
    .eq("is_enabled", true)
    .order("sort_order");
  if (error) return res.status(500).json({ error: "কনফিগ লোড ব্যর্থ" });
  res.json(data);
}));

// ── GET /fees — student-এর fee summary (due, paid, balance) ──
router.get("/fees", asyncHandler(async (req, res) => {
  const { data: items } = await supabase.from("fee_items").select("*").eq("student_id", req.student.student_id);
  const { data: payments } = await supabase.from("payments").select("*").eq("student_id", req.student.student_id);
  const totalDue = (items || []).reduce((s, i) => s + (i.amount || 0), 0);
  const totalPaid = (payments || []).reduce((s, p) => s + (p.amount || p.paid_amount || 0), 0);
  res.json({ items: items || [], payments: payments || [], totalDue, totalPaid, balance: totalDue - totalPaid });
}));

// ── GET /timeline — student-এর pipeline status ও তারিখ ──
router.get("/timeline", asyncHandler(async (req, res) => {
  const { data: student } = await supabase.from("students")
    .select("id, status, created_at")
    .eq("id", req.student.student_id).single();
  // ভবিষ্যতে activity_log table থেকে বিস্তারিত timeline দেখানো যাবে
  res.json({ status: student?.status, created_at: student?.created_at });
}));

// ── POST /change-password — student নিজের portal password পরিবর্তন ──
router.post("/change-password", asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: "পুরানো ও নতুন পাসওয়ার্ড দিন" });
  if (new_password.length < 8) return res.status(400).json({ error: "পাসওয়ার্ড কমপক্ষে ৮ অক্ষর" });

  const { data: student } = await supabase.from("students")
    .select("portal_password_hash").eq("id", req.student.student_id).single();
  if (!student) return res.status(404).json({ error: "Student not found" });

  const valid = await bcrypt.compare(current_password, student.portal_password_hash);
  if (!valid) return res.status(401).json({ error: "পুরানো পাসওয়ার্ড ভুল" });

  const hash = await bcrypt.hash(new_password, 12);
  await supabase.from("students").update({ portal_password_hash: hash }).eq("id", req.student.student_id);
  res.json({ success: true, message: "পাসওয়ার্ড পরিবর্তন হয়েছে" });
}));

// ── GET /payments — student-এর বিস্তারিত পেমেন্ট ইতিহাস ──
router.get("/payments", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("payments")
    .select("id, category, label, amount, paid_amount, payment_method, method, date, notes, note, status, receipt_no, created_at")
    .eq("student_id", req.student.student_id)
    .order("date", { ascending: false });
  if (error) return res.status(500).json({ error: "পেমেন্ট লোড ব্যর্থ" });
  res.json(data || []);
}));

// ── GET /documents — student-এর সব ডকুমেন্ট তালিকা ──
router.get("/documents", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("documents")
    .select("id, doc_type, label, status, file_url, gdrive_url, upload_date, notes, created_at, updated_at")
    .eq("student_id", req.student.student_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "ডকুমেন্ট লোড ব্যর্থ" });
  res.json(data || []);
}));

// ── POST /documents/upload — student নিজে ডকুমেন্ট আপলোড করতে পারে ──
router.post("/documents/upload", portalDocUpload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
  const { doc_type, label, notes } = req.body;
  if (!doc_type) return res.status(400).json({ error: "ডকুমেন্ট টাইপ দিন" });

  const fileUrl = `/uploads/portal-docs/${req.file.filename}`;
  const record = {
    student_id: req.student.student_id,
    agency_id: req.student.agency_id,
    doc_type,
    label: label || doc_type,
    status: "pending",
    file_url: fileUrl,
    upload_date: new Date().toISOString().slice(0, 10),
    notes: notes || null,
  };

  const { data, error } = await supabase.from("documents").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "আপলোড ব্যর্থ" }); }
  res.status(201).json(data);
}));

module.exports = router;
