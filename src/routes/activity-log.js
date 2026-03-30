/**
 * activity-log.js — কার্যকলাপ লগ API
 * Frontend থেকে activity log save ও read
 */
const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();
router.use(auth);

// POST /api/activity-log — নতুন log entry
router.post("/", asyncHandler(async (req, res) => {
  const { module, record_id, action, description, old_value, new_value } = req.body;
  const { data, error } = await supabase.from("activity_log").insert({
    agency_id: req.user.agency_id,
    user_id: req.user.id,
    module: module || "general",
    record_id: record_id || null,
    action: action || "action",
    description: description || "",
    old_value: old_value ? JSON.stringify(old_value) : null,
    new_value: new_value ? JSON.stringify(new_value) : null,
    ip_address: req.ip,
  }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// GET /api/activity-log — লগ তালিকা (student_id বা module filter)
router.get("/", asyncHandler(async (req, res) => {
  const { record_id, module, limit: rawLimit = 50 } = req.query;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  let q = supabase.from("activity_log")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (record_id) q = q.eq("record_id", record_id);
  if (module) q = q.eq("module", module);
  const { data, error } = await q;
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

module.exports = router;
