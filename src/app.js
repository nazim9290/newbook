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
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'");
  next();
});

// CORS: exact domain matching — .includes() ব্যবহার নিষেধ (subdomain attack প্রতিরোধ)
const allowedOrigins = new Set([
  "https://agencybook.net",
  "https://www.agencybook.net",
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
    // Production — exact match only
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    callback(new Error("CORS not allowed"), false);
  },
  credentials: true,
}));

// JSON body parser: max 1MB (DoS prevention)
app.use(express.json({ limit: "1mb" }));

// ── Global Rate Limiter — প্রতি IP থেকে ১ মিনিটে সর্বোচ্চ ১০০ request ──
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // ১ মিনিট
  max: 100,              // সর্বোচ্চ ১০০ request
  message: { error: "অনেক বেশি request — ১ মিনিট পরে চেষ্টা করুন" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

// ── Health Check — সার্ভার চালু আছে কিনা check করতে ──
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

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
app.use("/api/student-portal", require("./routes/student-portal")); // স্টুডেন্ট পোর্টাল (self-service)
app.use("/api/reports", require("./routes/reports"));               // রিপোর্ট ও Analytics
app.use("/api/partners", require("./routes/partners"));             // পার্টনার এজেন্সি (B2B)
app.use("/api/pre-departure", require("./routes/pre-departure"));   // প্রি-ডিপার্চার ও VFS

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
