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
  // feedback JSONB string → array parse
  const parsed = (data || []).map(s => ({
    ...s,
    feedback: typeof s.feedback === "string" ? JSON.parse(s.feedback) : (s.feedback || []),
  }));
  res.json(parsed);
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
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// PATCH /api/submissions/:id — status update, feedback add
router.patch("/:id", asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("submissions").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন", code: "CONFLICT" });
    }
  }

  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("submissions").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select("*, students(name_en), schools(name_en)").single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// POST /api/submissions/:id/feedback — add recheck feedback
router.post("/:id/feedback", asyncHandler(async (req, res) => {
  const { doc, issue, severity } = req.body;
  if (!doc || !issue) return res.status(400).json({ error: "doc ও issue দিন" });

  // Get current submission
  const { data: sub } = await supabase.from("submissions").select("feedback, recheck_count").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!sub) return res.status(404).json({ error: "Submission পাওয়া যায়নি" });

  const existing = typeof sub.feedback === "string" ? JSON.parse(sub.feedback) : (sub.feedback || []);
  const feedback = [...existing, { doc, issue, severity: severity || "warning", date: new Date().toISOString().slice(0, 10), resolved: false }];

  const { data, error } = await supabase.from("submissions").update({
    feedback: JSON.stringify(feedback),
    status: "issues_found",
    recheck_count: (sub.recheck_count || 0) + 1,
  }).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  // Response-এ feedback parsed array হিসেবে পাঠাও
  if (data) data.feedback = typeof data.feedback === "string" ? JSON.parse(data.feedback) : (data.feedback || []);
  res.json(data);
}));

// PATCH /api/submissions/:id/feedback/:index/resolve — mark feedback resolved
router.patch("/:id/feedback/:index/resolve", asyncHandler(async (req, res) => {
  const { data: sub } = await supabase.from("submissions").select("feedback").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!sub) return res.status(404).json({ error: "Submission পাওয়া যায়নি" });

  const feedback = typeof sub.feedback === "string" ? JSON.parse(sub.feedback) : [...(sub.feedback || [])];
  const idx = parseInt(req.params.index);
  if (feedback[idx]) feedback[idx].resolved = true;

  const allResolved = feedback.every(f => f.resolved);
  const { data, error } = await supabase.from("submissions").update({
    feedback: JSON.stringify(feedback),
    status: allResolved ? "resubmitted" : "issues_found",
  }).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  if (data) data.feedback = typeof data.feedback === "string" ? JSON.parse(data.feedback) : (data.feedback || []);
  res.json(data);
}));

// DELETE /api/submissions/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("submissions").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ success: true });
}));

module.exports = router;
