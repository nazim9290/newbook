const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/schools
router.get("/", async (req, res) => {
  const { country } = req.query;
  let query = supabase.from("schools").select("*").order("name_en");
  if (country && country !== "All") query = query.eq("country", country);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/schools — নতুন স্কুল তৈরি
router.post("/", async (req, res) => {
  const record = {
    ...req.body,
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
  };
  const { data, error } = await supabase.from("schools").insert(record).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/schools/:id
router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("schools").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/schools/:id/submissions
router.get("/:id/submissions", async (req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .select("*, students(name_en)")
    .eq("school_id", req.params.id)
    .order("submission_date", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/schools/:id/submissions
router.post("/:id/submissions", async (req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .insert({ ...req.body, school_id: req.params.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/schools/submissions/:subId
router.patch("/submissions/:subId", async (req, res) => {
  const { data, error } = await supabase.from("submissions").update(req.body).eq("id", req.params.subId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
