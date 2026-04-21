/**
 * resume.js — 履歴書 (Resume) support: Work Experience + JP Study History
 *
 * Work Experience (student_work_experience table — 職歴):
 *   POST   /:id/work-experience            — add
 *   DELETE /:id/work-experience/:weId      — delete
 *
 * JP Study History (student_jp_study table — 日本語学習歴):
 *   POST   /:id/jp-study                   — add
 *   PATCH  /:id/jp-study/:jsId             — update
 *   DELETE /:id/jp-study/:jsId             — delete
 */

const express = require("express");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// ── Work Experience CRUD — 職歴 (Resume support) ──
// POST /api/students/:id/work-experience — নতুন কর্ম অভিজ্ঞতা যোগ
router.post("/:id/work-experience", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { company_name, address, start_date, end_date, position } = req.body;
  const { data, error } = await supabase.from("student_work_experience").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    company_name, address, start_date, end_date, position,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// DELETE /api/students/:id/work-experience/:weId — কর্ম অভিজ্ঞতা মুছুন
router.delete("/:id/work-experience/:weId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_work_experience").delete().eq("id", req.params.weId);
  res.json({ success: true });
}));

// ── JP Study History CRUD — 日本語学習歴 (Resume support) ──
// POST /api/students/:id/jp-study — নতুন জাপানি ভাষা শিক্ষা ইতিহাস যোগ
router.post("/:id/jp-study", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { institution, address, period_from, period_to, total_hours } = req.body;
  const { data, error } = await supabase.from("student_jp_study").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    institution, address, period_from, period_to, total_hours,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// PATCH /api/students/:id/jp-study/:jsId — জাপানি ভাষা শিক্ষা ইতিহাস আপডেট
router.patch("/:id/jp-study/:jsId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { institution, address, period_from, period_to, total_hours } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (institution !== undefined) update.institution = institution;
  if (address !== undefined) update.address = address;
  if (period_from !== undefined) update.period_from = period_from;
  if (period_to !== undefined) update.period_to = period_to;
  if (total_hours !== undefined) update.total_hours = total_hours;
  const { data, error } = await supabase.from("student_jp_study").update(update).eq("id", req.params.jsId).eq("student_id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// DELETE /api/students/:id/jp-study/:jsId — জাপানি ভাষা শিক্ষা ইতিহাস মুছুন
router.delete("/:id/jp-study/:jsId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_jp_study").delete().eq("id", req.params.jsId);
  res.json({ success: true });
}));

module.exports = router;
