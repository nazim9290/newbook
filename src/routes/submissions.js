const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  const { school_id, student_id, status } = req.query;
  let q = supabase.from("submissions").select("*, students(name_en), schools(name_en)").order("submission_date", { ascending: false });
  if (school_id) q = q.eq("school_id", school_id);
  if (student_id) q = q.eq("student_id", student_id);
  if (status && status !== "All") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("submissions").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("submissions").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
