const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  const { student_id, visitor_id, type } = req.query;
  let q = supabase.from("communications").select("*, students(name_en)").order("created_at", { ascending: false });
  if (student_id) q = q.eq("student_id", student_id);
  if (visitor_id) q = q.eq("visitor_id", visitor_id);
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("communications").insert({ ...req.body, agency_id: req.user.agency_id, logged_by: req.user.id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("communications").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
