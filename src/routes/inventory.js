const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const router = express.Router();
router.use(auth);

router.get("/", checkPermission("inventory", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("inventory").select("*").eq("agency_id", req.user.agency_id).order("name");
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.post("/", checkPermission("inventory", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("inventory").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

router.patch("/:id", checkPermission("inventory", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("inventory").update(req.body).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

router.delete("/:id", checkPermission("inventory", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("inventory").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

module.exports = router;
