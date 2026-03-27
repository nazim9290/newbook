const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const router = express.Router();
router.use(auth);

router.get("/", checkPermission("agents", "read"), asyncHandler(async (req, res) => {
  const { status } = req.query;
  let q = supabase.from("agents").select("*").order("name");
  if (status && status !== "All") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.post("/", checkPermission("agents", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("agents").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

router.patch("/:id", checkPermission("agents", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("agents").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.delete("/:id", checkPermission("agents", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("agents").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

module.exports = router;
