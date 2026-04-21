/**
 * education.js — Education + JP Exam CRUD routes
 *
 * Education (student_education table):
 *   POST   /:id/education              — নতুন শিক্ষা রেকর্ড
 *   PATCH  /:id/education/:eduId       — update
 *   DELETE /:id/education/:eduId       — delete
 *
 * JP Exam (student_jp_exams table):
 *   POST   /:id/exam-result            — JLPT/NAT result save (id দিলে update, না দিলে insert)
 *   PATCH  /:id/jp-exams/:examId       — update
 *   DELETE /:id/jp-exams/:examId       — delete
 */

const express = require("express");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// POST /api/students/:id/exam-result — JLPT/NAT পরীক্ষার ফলাফল save/update
router.post("/:id/exam-result", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { exam_type, level, score, result, exam_date, exam_id } = req.body;
  if (!exam_type) return res.status(400).json({ error: "পরীক্ষার ধরন দিন" });

  // exam_id থাকলে update, না থাকলে insert
  if (exam_id) {
    const { data, error } = await supabase.from("student_jp_exams").update({
      exam_type, level, score: score || null, result: result || null,
      exam_date: exam_date || null,
    }).eq("id", exam_id).eq("agency_id", req.user.agency_id).select().single();
    if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "আপডেট ব্যর্থ" }); }
    return res.json(data);
  }

  // নতুন insert
  const { data, error } = await supabase.from("student_jp_exams").insert({
    student_id: req.params.id,
    agency_id: req.user.agency_id,
    exam_type, level, score: score || null, result: result || null,
    exam_date: exam_date || null,
  }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// ── Education CRUD — শিক্ষাগত তথ্য (+ entrance_year, address, school_type for Resume) ──
router.post("/:id/education", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { level, school_name, year, board, gpa, group_name, entrance_year, address, school_type } = req.body;
  const { data, error } = await supabase.from("student_education").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    level, school_name, year, board, gpa, group_name,
    entrance_year: entrance_year || "", address: address || "", school_type: school_type || "",
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.patch("/:id/education/:eduId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { level, school_name, year, board, gpa, group_name, entrance_year, address, school_type } = req.body;
  const { data, error } = await supabase.from("student_education").update({
    level, school_name, year, board, gpa, group_name,
    entrance_year: entrance_year || "", address: address || "", school_type: school_type || "",
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.eduId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

router.delete("/:id/education/:eduId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_education").delete().eq("id", req.params.eduId);
  res.json({ success: true });
}));

// PATCH /api/students/:id/jp-exams/:examId — পরীক্ষার ফলাফল আপডেট
router.patch("/:id/jp-exams/:examId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { exam_type, level, score, result, exam_date } = req.body;
  const { data, error } = await supabase.from("student_jp_exams").update({
    exam_type, level, score: score || null, result: result || null,
    exam_date: exam_date || null, updated_at: new Date().toISOString(),
  }).eq("id", req.params.examId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// DELETE /api/students/:id/jp-exams/:examId — পরীক্ষার ফলাফল মুছুন
router.delete("/:id/jp-exams/:examId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_jp_exams").delete().eq("id", req.params.examId);
  res.json({ success: true });
}));

module.exports = router;
