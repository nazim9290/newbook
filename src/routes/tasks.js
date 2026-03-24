const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/tasks
router.get("/", async (req, res) => {
  const { status, assigned_to, priority } = req.query;
  let query = supabase.from("tasks").select("*").order("due_date");
  if (status && status !== "All") query = query.eq("status", status);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (priority && priority !== "All") query = query.eq("priority", priority);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/tasks
router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("tasks").insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/tasks/:id
router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("tasks").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/tasks/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("tasks").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
