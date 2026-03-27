const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// GET /api/attendance?date=2026-03-24&batch=xyz
router.get("/", asyncHandler(async (req, res) => {
  const { date, batch } = req.query;
  if (!date) return res.status(400).json({ error: "তারিখ দিন" });

  let query = supabase.from("attendance").select("*, students(name_en, batch)").eq("date", date);
  if (batch && batch !== "all") query = query.eq("students.batch", batch);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/attendance/save — bulk save for a date
// body: { date: "2026-03-24", records: [{ student_id, status }] }
router.post("/save", asyncHandler(async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: "date ও records দিন" });

  const rows = records.map((r) => ({ date, student_id: r.student_id, status: r.status }));

  // upsert — insert or update on (date, student_id) conflict
  const { data, error } = await supabase
    .from("attendance")
    .upsert(rows, { onConflict: "date,student_id" })
    .select();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ saved: data.length });
}));

module.exports = router;
