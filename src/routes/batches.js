const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

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

  // প্রতিটি batch-এ enrolled student count যোগ
  const pool = supabase.pool;
  for (const batch of (data || [])) {
    try {
      const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS count FROM batch_students WHERE batch_id = $1",
        [batch.id]
      );
      batch.enrolledCount = rows[0]?.count || 0;
    } catch { batch.enrolledCount = 0; }
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
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

// PATCH /api/batches/:id
router.patch("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("batches").update(req.body).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
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
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
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
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: error.message }); }
  res.status(201).json(data);
}));

// GET /api/batches/:id/tests — ক্লাস টেস্ট তালিকা
router.get("/:id/tests", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("class_tests")
    .select("*").eq("batch_id", req.params.id).order("date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
}));

module.exports = router;
