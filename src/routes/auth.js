const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../lib/supabase");
const asyncHandler = require("../lib/asyncHandler");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// Rate limiter — ১৫ মিনিটে সর্বোচ্চ ১০ বার login চেষ্টা
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "অনেকবার চেষ্টা করেছেন — ১৫ মিনিট পরে আবার চেষ্টা করুন" },
  standardHeaders: true,
});

// Email format validation helper
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// POST /api/auth/login
router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email ও password দিন" });

  // Input validation — email format check
  if (!isValidEmail(email)) return res.status(400).json({ error: "সঠিক email দিন" });
  if (!password.trim()) return res.status(400).json({ error: "Password দিন" });

  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", email.toLowerCase())
    .single();

  if (error || !user) return res.status(401).json({ error: "Email বা password ভুল" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Email বা password ভুল" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id }
  });
}));

// POST /api/auth/student-login — Student Portal Login (staff login থেকে আলাদা)
router.post("/student-login", loginLimiter, asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "ফোন ও পাসওয়ার্ড দিন" });

  // ফোন নম্বর দিয়ে student খুঁজো — portal access enabled কিনা চেক
  const { data: student, error } = await supabase.from("students")
    .select("id, name_en, name_bn, phone, email, status, country, school, batch, branch, portal_password_hash, portal_access, portal_sections, agency_id")
    .eq("phone", phone).single();

  if (error || !student) return res.status(401).json({ error: "ফোন নম্বর পাওয়া যায়নি" });
  if (!student.portal_access) return res.status(403).json({ error: "পোর্টাল অ্যাক্সেস বন্ধ আছে — এজেন্সিতে যোগাযোগ করুন" });
  if (!student.portal_password_hash) return res.status(403).json({ error: "পোর্টাল পাসওয়ার্ড সেট করা হয়নি — এজেন্সিতে যোগাযোগ করুন" });

  const valid = await bcrypt.compare(password, student.portal_password_hash);
  if (!valid) return res.status(401).json({ error: "পাসওয়ার্ড ভুল হয়েছে" });

  // সর্বশেষ login সময় আপডেট
  await supabase.from("students").update({ last_portal_login: new Date().toISOString() }).eq("id", student.id);

  const token = jwt.sign(
    { type: "student", student_id: student.id, name: student.name_en, agency_id: student.agency_id },
    process.env.JWT_SECRET, { expiresIn: "7d" }
  );

  res.json({
    token,
    user: { id: student.id, name: student.name_en, name_bn: student.name_bn, type: "student", phone: student.phone, status: student.status, country: student.country, school: student.school, batch: student.batch }
  });
}));

// POST /api/auth/register (admin only — create new staff account)
router.post("/register", loginLimiter, asyncHandler(async (req, res) => {
  const { name, email, password, role, branch } = req.body;

  // Input validation
  if (!name || !name.trim()) return res.status(400).json({ error: "নাম দিন" });
  if (!email) return res.status(400).json({ error: "Email দিন" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "সঠিক email দিন" });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password কমপক্ষে ৬ অক্ষর হতে হবে" });

  const hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from("users")
    .insert({ name, email: email.toLowerCase(), password_hash: hash, role: role || "counselor", branch })
    .select("id, name, email, role, branch")
    .single();

  if (error) return res.status(400).json({ error: "রেজিস্ট্রেশন ব্যর্থ — email ইতিমধ্যে ব্যবহৃত হতে পারে" });
  res.status(201).json(data);
}));

module.exports = router;
