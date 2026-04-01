const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../lib/supabase");
const asyncHandler = require("../lib/asyncHandler");
const rateLimit = require("express-rate-limit");
const auth = require("../middleware/auth");
const { getPermissionsForRole } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();

// Rate limiter — ১৫ মিনিটে সর্বোচ্চ ১০ বার login চেষ্টা
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "অনেকবার চেষ্টা করেছেন — ১৫ মিনিট পরে আবার চেষ্টা করুন" },
  standardHeaders: true,
});

// Email format validation
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

// ── Cookie config — httpOnly, secure, SameSite ──
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,          // JavaScript থেকে access করা যাবে না (XSS protection)
  secure: isProduction,    // HTTPS-এ শুধু পাঠাবে (production)
  sameSite: "lax",         // CSRF protection
  maxAge: 7 * 24 * 60 * 60 * 1000,  // ৭ দিন
  path: "/",
};

// ── Helper: cookie-তে token set করো ──
function setTokenCookie(res, token) {
  res.cookie("agencybook_token", token, COOKIE_OPTS);
}

// POST /api/auth/login
router.post("/login", loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email ও password দিন" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "সঠিক email দিন" });
  if (!password.trim()) return res.status(400).json({ error: "Password দিন" });

  const { data: user, error } = await supabase
    .from("users").select("*").eq("email", email.toLowerCase()).single();

  if (error || !user) return res.status(401).json({ error: "Email বা password ভুল" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Email বা password ভুল" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  // httpOnly cookie-তে token set (XSS safe)
  setTokenCookie(res, token);

  // Activity log — login (non-blocking)
  logActivity({ agencyId: user.agency_id, userId: user.id, action: "login", module: "auth",
    description: `Login: ${user.email}`, ip: req.ip }).catch(() => {});

  // JSON-এও token পাঠাও (backward compatibility)
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id, avatar_url: user.avatar_url || null, phone: user.phone || null, created_at: user.created_at }
  });
}));

// POST /api/auth/student-login — Student Portal Login
router.post("/student-login", loginLimiter, asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "ফোন ও পাসওয়ার্ড দিন" });

  const { data: student, error } = await supabase.from("students")
    .select("id, name_en, name_bn, phone, email, status, country, school, batch, branch, portal_password_hash, portal_access, portal_sections, agency_id")
    .eq("phone", phone).single();

  if (error || !student) return res.status(401).json({ error: "ফোন নম্বর পাওয়া যায়নি" });
  if (!student.portal_access) return res.status(403).json({ error: "পোর্টাল অ্যাক্সেস বন্ধ আছে — এজেন্সিতে যোগাযোগ করুন" });
  if (!student.portal_password_hash) return res.status(403).json({ error: "পোর্টাল পাসওয়ার্ড সেট করা হয়নি — এজেন্সিতে যোগাযোগ করুন" });

  const valid = await bcrypt.compare(password, student.portal_password_hash);
  if (!valid) return res.status(401).json({ error: "পাসওয়ার্ড ভুল হয়েছে" });

  await supabase.from("students").update({ last_portal_login: new Date().toISOString() }).eq("id", student.id);

  const token = jwt.sign(
    { type: "student", student_id: student.id, name: student.name_en, agency_id: student.agency_id },
    process.env.JWT_SECRET, { expiresIn: "7d" }
  );

  // httpOnly cookie set
  res.cookie("agencybook_student_token", token, COOKIE_OPTS);

  res.json({
    token,
    user: { id: student.id, name: student.name_en, name_bn: student.name_bn, type: "student", phone: student.phone, status: student.status, country: student.country, school: student.school, batch: student.batch }
  });
}));

// POST /api/auth/logout — cookie clear
router.post("/logout", (req, res) => {
  res.clearCookie("agencybook_token", { path: "/" });
  res.clearCookie("agencybook_student_token", { path: "/" });
  res.json({ success: true });
});

// POST /api/auth/register (admin only — create new staff account)
// auth middleware দিয়ে agency_id নেওয়া হয়
router.post("/register", auth, asyncHandler(async (req, res) => {
  const { name, email, password, role, branch } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: "নাম দিন" });
  if (!email) return res.status(400).json({ error: "Email দিন" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "সঠিক email দিন" });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password কমপক্ষে ৮ অক্ষর হতে হবে" });

  const hash = await bcrypt.hash(password, 12);
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

  const { data, error } = await supabase
    .from("users")
    .insert({ name, email: email.toLowerCase(), password_hash: hash, role: role || "counselor", branch, agency_id: agencyId })
    .select("id, name, email, role, branch")
    .single();

  if (error) return res.status(400).json({ error: "রেজিস্ট্রেশন ব্যর্থ — email ইতিমধ্যে ব্যবহৃত হতে পারে" });
  res.status(201).json(data);
}));

// GET /api/auth/permissions
router.get("/permissions", auth, asyncHandler(async (req, res) => {
  const permissions = getPermissionsForRole(req.user.role);
  res.json({ role: req.user.role, permissions });
}));

// ── POST /api/auth/upload-avatar — প্রোফাইল ছবি আপলোড ──
const multer = require("multer");
const path = require("path");
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"), "avatars");
    require("fs").mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${req.user.id}${path.extname(file.originalname)}`),
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("শুধু JPG, PNG, WEBP ফাইল আপলোড করুন"));
  },
});

router.post("/upload-avatar", auth, avatarUpload.single("avatar"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
  const avatarUrl = `/uploads/avatars/${req.file.filename}`;

  await supabase.from("users").update({ avatar_url: avatarUrl }).eq("id", req.user.id);
  res.json({ avatar_url: avatarUrl });
}));

// ── POST /api/auth/upload-logo — এজেন্সি লোগো আপলোড ──
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"), "logos");
    require("fs").mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${req.user.agency_id}${path.extname(file.originalname)}`),
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|svg)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("শুধু JPG, PNG, WEBP, SVG ফাইল আপলোড করুন"));
  },
});

router.post("/upload-logo", auth, logoUpload.single("logo"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
  const logoUrl = `/uploads/logos/${req.file.filename}`;

  await supabase.from("agencies").update({ logo_url: logoUrl }).eq("id", req.user.agency_id);
  res.json({ logo_url: logoUrl });
}));

module.exports = router;
