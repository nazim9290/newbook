const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  const { month, type } = req.query;
  let q = supabase.from("calendar_events").select("*, students(name_en)").order("date");
  if (month) q = q.gte("date", month + "-01").lte("date", month + "-31");
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("calendar_events").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase.from("calendar_events").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("calendar_events").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
