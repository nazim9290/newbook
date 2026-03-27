/**
 * submissions.js — School Submission ও Recheck Management
 *
 * Workflow:
 * 1. Student documents স্কুলে submit
 * 2. স্কুল review করে — accepted / issues_found / rejected
 * 3. Issues থাকলে recheck — feedback সহ resubmit
 * 4. Final: COE received / visa processing
 */

const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();
router.use(auth);

// GET /api/submissions — list with filters
router.get("/", asyncHandler(async (req, res) => {
  const { school_id, student_id, status } = req.query;
  let q = supabase.from("submissions").select("*, students(name_en, phone, status), schools(name_en, name_jp)").eq("agency_id", req.user.agency_id).order("submission_date", { ascending: false });
  if (school_id) q = q.eq("school_id", school_id);
  if (student_id) q = q.eq("student_id", student_id);
  if (status && status !== "All") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data || []);
}));

// POST /api/submissions — নতুন submission
router.post("/", asyncHandler(async (req, res) => {
  const record = {
    ...req.body,
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
    submission_date: req.body.submission_date || new Date().toISOString().slice(0, 10),
    status: req.body.status || "submitted",
  };
  const { data, error } = await supabase.from("submissions").insert(record).select("*, students(name_en), schools(name_en)").single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

// PATCH /api/submissions/:id — status update, feedback add
router.patch("/:id", asyncHandler(async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("submissions").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select("*, students(name_en), schools(name_en)").single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/submissions/:id/feedback — add recheck feedback
router.post("/:id/feedback", asyncHandler(async (req, res) => {
  const { doc, issue, severity } = req.body;
  if (!doc || !issue) return res.status(400).json({ error: "doc ও issue দিন" });

  // Get current submission
  const { data: sub } = await supabase.from("submissions").select("feedback, recheck_count").eq("id", req.params.id).single();
  if (!sub) return res.status(404).json({ error: "Submission পাওয়া যায়নি" });

  const feedback = [...(sub.feedback || []), { doc, issue, severity: severity || "warning", date: new Date().toISOString().slice(0, 10), resolved: false }];

  const { data, error } = await supabase.from("submissions").update({
    feedback,
    status: "issues_found",
    recheck_count: (sub.recheck_count || 0) + 1,
    last_recheck_date: new Date().toISOString().slice(0, 10),
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.id).select("*, students(name_en), schools(name_en)").single();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// PATCH /api/submissions/:id/feedback/:index/resolve — mark feedback resolved
router.patch("/:id/feedback/:index/resolve", asyncHandler(async (req, res) => {
  const { data: sub } = await supabase.from("submissions").select("feedback").eq("id", req.params.id).single();
  if (!sub) return res.status(404).json({ error: "Submission পাওয়া যায়নি" });

  const feedback = [...(sub.feedback || [])];
  const idx = parseInt(req.params.index);
  if (feedback[idx]) feedback[idx].resolved = true;

  const allResolved = feedback.every(f => f.resolved);
  const { data, error } = await supabase.from("submissions").update({
    feedback,
    status: allResolved ? "resubmitted" : "issues_found",
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.id).select("*, students(name_en), schools(name_en)").single();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// DELETE /api/submissions/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("submissions").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

module.exports = router;
