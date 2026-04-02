const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

// GET /api/batches
router.get("/", asyncHandler(async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("batches").select("*").eq("agency_id", req.user.agency_id).order("start_date", { ascending: false });
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // একটি query-তে সব batch-এর student count আনা (N+1 সমস্যা সমাধান)
  if (data && data.length > 0) {
    try {
      const pool = supabase.pool;
      const batchIds = data.map(b => b.id);
      const { rows: counts } = await pool.query(
        `SELECT batch_id, COUNT(*)::int AS count
         FROM batch_students
         WHERE batch_id = ANY($1)
         GROUP BY batch_id`,
        [batchIds]
      );
      const countMap = Object.fromEntries(counts.map(r => [r.batch_id, r.count]));
      data.forEach(b => b.enrolledCount = countMap[b.id] || 0);
    } catch { data.forEach(b => b.enrolledCount = 0); }
  }

  res.json(data);
}));

// GET /api/batches/:id — with enrolled students
router.get("/:id", asyncHandler(async (req, res) => {
  const { data: batch, error } = await supabase
    .from("batches")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (error) return res.status(404).json({ error: "Batch পাওয়া যায়নি" });

  const { data: enrollments } = await supabase
    .from("batch_students")
    .select("*, students(name_en, phone, status)")
    .eq("batch_id", req.params.id);

  // Class tests
  const { data: tests } = await supabase.from("class_tests")
    .select("*").eq("batch_id", req.params.id).order("date", { ascending: false });

  res.json({ ...batch, enrollments: enrollments || [], tests: tests || [] });
}));

// POST /api/batches — নতুন ব্যাচ তৈরি
// agency_id JWT থেকে auto-set, branch frontend থেকে আসে
router.post("/", asyncHandler(async (req, res) => {
  const record = {
    ...req.body,
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
    branch: req.body.branch || req.user.branch || "Main",
  };
  const { data, error } = await supabase.from("batches").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — নতুন ব্যাচ তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "batches",
    recordId: data.id, description: `নতুন ব্যাচ: ${data.name || ""}`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// PATCH /api/batches/:id
router.patch("/:id", asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("batches").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  const updates = { ...req.body, updated_at: new Date().toISOString() };

  const { data, error } = await supabase.from("batches").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — ব্যাচ আপডেট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "batches",
    recordId: req.params.id, description: `ব্যাচ আপডেট: ${data.name || req.params.id}`, ip: req.ip }).catch(() => {});

  res.json(data);
}));

// POST /api/batches/:id/enroll — enroll student
router.post("/:id/enroll", asyncHandler(async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: "student_id দিন" });
  const { data, error } = await supabase
    .from("batch_students")
    .insert({ batch_id: req.params.id, student_id })
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// POST /api/batches/:id/tests — ক্লাস টেস্ট যোগ
router.post("/:id/tests", asyncHandler(async (req, res) => {
  const { test_name, date, avg_score, scores } = req.body;
  if (!test_name) return res.status(400).json({ error: "টেস্টের নাম দিন" });
  const { data, error } = await supabase.from("class_tests").insert({
    batch_id: req.params.id,
    test_name, date: date || null,
    avg_score: avg_score || 0,
    scores: scores ? JSON.stringify(scores) : "{}",
  }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// GET /api/batches/:id/tests — ক্লাস টেস্ট তালিকা
router.get("/:id/tests", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("class_tests")
    .select("*").eq("batch_id", req.params.id).order("date", { ascending: false });
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

module.exports = router;
