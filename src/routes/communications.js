const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();
router.use(auth);

// GET — agency_id ফিল্টার সহ
router.get("/", asyncHandler(async (req, res) => {
  const { student_id, visitor_id, type } = req.query;
  let q = supabase.from("communications")
    .select("*, students(name_en)")
    .eq("agency_id", req.user.agency_id)  // tenancy enforcement
    .order("created_at", { ascending: false });
  if (student_id) q = q.eq("student_id", student_id);
  if (visitor_id) q = q.eq("visitor_id", visitor_id);
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST — agency_id auto-set
router.post("/", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("communications")
    .insert({ ...req.body, agency_id: req.user.agency_id, logged_by: req.user.id })
    .select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.status(201).json(data);
}));

// DELETE — agency_id চেক করে শুধু নিজের agency-র record মুছবে
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("communications")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);  // tenancy enforcement
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json({ success: true });
}));

module.exports = router;
