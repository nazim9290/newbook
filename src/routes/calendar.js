const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const router = express.Router();
router.use(auth);

router.get("/", checkPermission("calendar", "read"), asyncHandler(async (req, res) => {
  const { month, type } = req.query;
  let q = supabase.from("calendar_events").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("date");
  if (month) q = q.gte("date", month + "-01").lte("date", month + "-31");
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.post("/", checkPermission("calendar", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("calendar_events").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

router.patch("/:id", checkPermission("calendar", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("calendar_events").update(req.body).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.delete("/:id", checkPermission("calendar", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("calendar_events").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

module.exports = router;
