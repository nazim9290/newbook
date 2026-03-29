const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// GET /api/attendance?date=2026-03-24&batch=xyz
// agency_id ফিল্টার — শুধু নিজের agency-র attendance দেখাবে
router.get("/", asyncHandler(async (req, res) => {
  const { date, batch } = req.query;
  if (!date) return res.status(400).json({ error: "তারিখ দিন" });

  let query = supabase.from("attendance")
    .select("*")
    .eq("date", date)
    .eq("agency_id", req.user.agency_id);
  if (batch && batch !== "all") query = query.eq("batch_id", batch);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST /api/attendance/save — bulk save for a date
// agency_id প্রতিটি record-এ যোগ হবে
router.post("/save", asyncHandler(async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: "date ও records দিন" });
  if (records.length > 200) return res.status(400).json({ error: "একসাথে সর্বোচ্চ ২০০ record" });

  const agencyId = req.user.agency_id;
  const rows = records.map((r) => ({
    date,
    student_id: r.student_id,
    status: r.status,
    batch_id: req.body.batch_id || null,
    agency_id: agencyId,
    marked_by: req.user.id,
  }));

  const { data, error } = await supabase
    .from("attendance")
    .upsert(rows, { onConflict: "student_id,date" })
    .select();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json({ saved: data.length });
}));

module.exports = router;
