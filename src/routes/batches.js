const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/batches
router.get("/", async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("batches").select("*").order("start_date", { ascending: false });
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/batches/:id — with enrolled students
router.get("/:id", async (req, res) => {
  const { data: batch, error } = await supabase
    .from("batches")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "Batch পাওয়া যায়নি" });

  const { data: enrollments } = await supabase
    .from("batch_students")
    .select("*, students(name_en, phone, status)")
    .eq("batch_id", req.params.id);

  res.json({ ...batch, enrollments: enrollments || [] });
});

// POST /api/batches
router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("batches").insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/batches/:id
router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("batches").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/batches/:id/enroll — enroll student
router.post("/:id/enroll", async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: "student_id দিন" });
  const { data, error } = await supabase
    .from("batch_students")
    .insert({ batch_id: req.params.id, student_id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
