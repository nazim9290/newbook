/**
 * student-portal.js — Student Portal API Routes
 *
 * Student নিজে login করে নিজের profile, fees, timeline দেখতে পারে।
 * JWT token-এ type: "student" থাকে — staff token দিয়ে access হবে না।
 */

const express = require("express");
const supabase = require("../lib/supabase");
const asyncHandler = require("../lib/asyncHandler");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const router = express.Router();

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

module.exports = router;
