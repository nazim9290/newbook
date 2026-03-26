/**
 * app.js — AgencyOS Backend Server (মূল entry point)
 *
 * Express.js সার্ভার — Supabase (PostgreSQL) database-এর সাথে connected।
 * সব API route এখান থেকে register হয়।
 *
 * PORT: .env থেকে পড়ে, default 3001
 * CORS: frontend URL allow করে (localhost:5173 বা production URL)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const cors = require("cors");

const app = express();

// ── Middleware ──
// CORS: সব frontend origin allow (localhost যেকোনো port + production)
app.use(cors({
  origin: function (origin, callback) {
    // localhost যেকোনো port, production URL, অথবা no origin (Postman/curl)
    if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1") || origin.includes("onrender.com") || origin.includes("vercel.app") || origin.includes("netlify.app")) {
      callback(null, true);
    } else {
      callback(null, true); // সব allow — production-এ restrict করা যাবে
    }
  },
  credentials: true,
}));
// JSON body parser: request body থেকে JSON parse করতে
app.use(express.json());

// ── Health Check — সার্ভার চালু আছে কিনা check করতে ──
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
// API Routes — প্রতিটি module আলাদা route file-এ
// ═══════════════════════════════════════════════════════
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

// ── 404 Handler — route না পেলে error ──
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Error Handler — unexpected error ধরতে ──
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Server Start ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgencyOS API running on http://localhost:${PORT}`);
});
