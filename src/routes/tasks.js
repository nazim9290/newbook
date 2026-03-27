const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// GET /api/tasks
router.get("/", asyncHandler(async (req, res) => {
  const { status, assigned_to, priority } = req.query;
  let query = supabase.from("tasks").select("*").order("due_date");
  if (status && status !== "All") query = query.eq("status", status);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (priority && priority !== "All") query = query.eq("priority", priority);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/tasks
router.post("/", asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("tasks").insert(record).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

// PATCH /api/tasks/:id
router.patch("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("tasks").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// DELETE /api/tasks/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("tasks").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

module.exports = router;
