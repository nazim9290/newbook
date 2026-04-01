/**
 * app.js — AgencyBook Backend Server (মূল entry point)
 *
 * Express.js সার্ভার — PostgreSQL database-এর সাথে connected।
 * সব API route এখান থেকে register হয়।
 *
 * PORT: .env থেকে পড়ে, default 5000
 * CORS: exact domain matching (agencybook.net only)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const app = express();

// Nginx proxy-র পিছনে আছে — trust proxy enable
app.set("trust proxy", 1);

// ── Middleware ──

// Security headers — HSTS, XSS, clickjacking, MIME sniffing, CSP
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // CSP — API server-এ CSP লাগবে না (frontend-এ set করা উচিত)
  // res.setHeader("Content-Security-Policy", "...");  // API-তে বন্ধ
  next();
});

// CORS: exact domain matching — .includes() ব্যবহার নিষেধ (subdomain attack প্রতিরোধ)
const allowedOrigins = new Set([
  "https://agencybook.net",
  "https://www.agencybook.net",
  "https://demo.agencybook.net",
  ...(process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean),
]);
app.use(cors({
  origin: function (origin, callback) {
    // Postman/curl/server-to-server — no origin header
    if (!origin) return callback(null, true);
    // Development — শুধু localhost allow (exact check)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    // Production — exact match বা agencybook.net subdomain
    if (allowedOrigins.has(origin) || origin.endsWith(".agencybook.net")) {
      return callback(null, true);
    }
    console.error("[CORS Rejected]", origin);
    callback(new Error("CORS not allowed"), false);
  },
  credentials: true,
}));

// Cookie parser — httpOnly cookie থেকে JWT token পড়তে
app.use(cookieParser());

// JSON body parser: max 1MB (DoS prevention)
app.use(express.json({ limit: "1mb" }));

// Body sanitizer — empty date string → null (PostgreSQL compatibility)
const sanitizeBody = require("./middleware/sanitizeBody");
app.use(sanitizeBody);

// ── Auto Activity Log — POST/PATCH/DELETE response-এর পর log ──
const { logActivity } = require("./lib/activityLog");
app.use((req, res, next) => {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) return next();
  const oldJson = res.json.bind(res);
  res.json = function (data) {
    // Response পাঠানোর পর async log — main response block করবে না
    if (res.statusCode < 400 && req.user?.id) {
      const path = req.originalUrl.replace(/\/api\//, "").split("/");
      const mod = path[0] || "unknown";
      const action = req.method === "POST" ? "create" : req.method === "PATCH" ? "update" : "delete";
      logActivity({
        agencyId: req.user.agency_id, userId: req.user.id,
        action, module: mod, recordId: req.params?.id || data?.id || null,
        description: `${action} ${mod}`, ip: req.ip,
      }).catch(() => {});
    }
    return oldJson(data);
  };
  next();
});

// ── রেট লিমিট — প্রতি ইউজার ভিত্তিক (অফিস নেটওয়ার্কে সমস্যা হবে না) ──
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // ৩০০ req/min/user — CRM-এর জন্য যথেষ্ট
  keyGenerator: (req) => {
    // JWT থেকে user ID ব্যবহার, না পেলে IP fallback
    try {
      const token = req.headers.authorization?.split(" ")[1];
      if (token) {
        const decoded = require("jsonwebtoken").decode(token);
        if (decoded?.id) return decoded.id;
      }
    } catch {}
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // Nginx proxy-র পিছনে — validation বন্ধ
  message: { error: "অনেক বেশি রিকোয়েস্ট — কিছুক্ষণ পর চেষ্টা করুন" }
});
app.use("/api/", apiLimiter);

// ── রিকোয়েস্ট টাইমিং — slow API ট্র্যাক করা ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 2000) {
      console.warn(`[SLOW] ${req.method} ${req.originalUrl} — ${duration}ms (status: ${res.statusCode})`);
    }
  });
  next();
});

// ── Health Check — সার্ভার ও ডাটাবেস চালু আছে কিনা check করতে ──
const { pool } = require("./lib/supabase");
app.get("/api/health", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT 1");
    res.json({
      status: "ok",
      db: "connected",
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB"
    });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", db: "disconnected", error: err.message });
  }
});

// ── Agency self-service — নিজের agency info get/update (owner/admin) ──
const agencyAuth = require("./middleware/auth");
const agencySupa = require("./lib/supabase");
const agencyAsync = require("./lib/asyncHandler");
app.get("/api/agency/me", agencyAuth, agencyAsync(async (req, res) => {
  const { data, error } = await agencySupa.from("agencies").select("*").eq("id", req.user.agency_id).single();
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));
app.patch("/api/agency/me", agencyAuth, agencyAsync(async (req, res) => {
  const { name, name_bn, branch, phone, email, address, logo_url } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (name_bn !== undefined) updates.name_bn = name_bn;
  if (branch !== undefined) updates.branch = branch;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (address !== undefined) updates.address = address;
  if (logo_url !== undefined) updates.logo_url = logo_url;
  const { data, error } = await agencySupa.from("agencies").update(updates).eq("id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// API Routes — প্রতিটি module আলাদা route file-এ
// ═══════════════════════════════════════════════════════
app.use("/api/dashboard", require("./routes/dashboard"));       // Dashboard stats
app.use("/api/super-admin", require("./routes/super-admin"));   // Super Admin — agency management
app.use("/api/auth", require("./routes/auth"));                 // লগইন ও রেজিস্ট্রেশন
app.use("/api/students", require("./routes/students"));         // স্টুডেন্ট CRUD
app.use("/api/visitors", require("./routes/visitors"));         // ভিজিটর/লিড CRUD
app.use("/api/attendance", require("./routes/attendance"));     // উপস্থিতি
app.use("/api/accounts", require("./routes/accounts"));         // আয়-ব্যয় হিসাব
app.use("/api/schools", require("./routes/schools"));           // ভাষা স্কুল
app.use("/api/batches", require("./routes/batches"));           // কোর্স ব্যাচ
app.use("/api/documents", require("./routes/documents"));       // ডকুমেন্ট ম্যানেজমেন্ট
app.use("/api/hr", require("./routes/hr"));                     // কর্মচারী ও বেতন
app.use("/api/tasks", require("./routes/tasks"));               // টাস্ক ম্যানেজমেন্ট
app.use("/api/excel", require("./routes/excel"));               // Excel রিজুইমি Auto-fill
app.use("/api/agents", require("./routes/agents"));             // রেফারেল এজেন্ট
app.use("/api/calendar", require("./routes/calendar"));         // ক্যালেন্ডার ইভেন্ট
app.use("/api/communications", require("./routes/communications")); // যোগাযোগ লগ
app.use("/api/inventory", require("./routes/inventory"));       // সম্পদ ও মালামাল
app.use("/api/submissions", require("./routes/submissions"));   // স্কুলে submission
app.use("/api/docgen", require("./routes/docgen"));             // Document Generator (Translation)
app.use("/api/docdata", require("./routes/docdata"));           // Document Types ও Student Document Data
app.use("/api/users", require("./routes/users"));               // ইউজার ও Branch ম্যানেজমেন্ট
app.use("/api/branches", require("./routes/branches"));         // শাখা CRUD (ঠিকানা, ফোন, ম্যানেজার)
app.use("/api/activity-log", require("./routes/activity-log")); // কার্যকলাপ লগ
app.use("/api/student-portal", require("./routes/student-portal")); // স্টুডেন্ট পোর্টাল (self-service)
app.use("/api/reports", require("./routes/reports"));               // রিপোর্ট ও Analytics
app.use("/api/partners", require("./routes/partners"));             // পার্টনার এজেন্সি (B2B)
app.use("/api/pre-departure", require("./routes/pre-departure"));   // প্রি-ডিপার্চার ও VFS
app.use("/api/ocr", require("./routes/ocr"));                       // OCR — জন্ম নিবন্ধন স্ক্যান (Google Vision)

// ── 404 Handler — route না পেলে error (path leak করবে না) ──
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Error Handler — unexpected error ধরতে (DB details client-এ পাঠায় না) ──
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
});

// ── Server Start ──
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`AgencyBook API running on http://localhost:${PORT}`);
});
