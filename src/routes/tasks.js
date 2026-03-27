const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// GET /api/tasks — agency_id ফিল্টার সহ
router.get("/", checkPermission("tasks", "read"), asyncHandler(async (req, res) => {
  const { status, assigned_to, priority } = req.query;
  let query = supabase.from("tasks").select("*")
    .eq("agency_id", req.user.agency_id)
    .order("due_date");
  if (status && status !== "All") query = query.eq("status", status);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (priority && priority !== "All") query = query.eq("priority", priority);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST /api/tasks
router.post("/", checkPermission("tasks", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id, created_by: req.user.id };
  const { data, error } = await supabase.from("tasks").insert(record).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.status(201).json(data);
}));

// PATCH /api/tasks/:id — agency_id চেক সহ
router.patch("/:id", checkPermission("tasks", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("tasks").update(req.body)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// DELETE /api/tasks/:id — agency_id চেক সহ
router.delete("/:id", checkPermission("tasks", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("tasks").delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json({ success: true });
}));

module.exports = router;
