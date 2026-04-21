/**
 * match-data.js — Smart Matching data endpoint
 *
 * GET /match-data — সব student-এর education + JP exam data
 * ⚠️ /:id-এর আগে register হতে হবে — না হলে "match-data" কে id হিসেবে ধরবে
 */

const express = require("express");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// GET /api/students/match-data — Smart Matching-এর জন্য সব student-এর education + JP exam data
router.get("/match-data", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const [eduRes, jpRes] = await Promise.all([
    supabase.from("student_education").select("student_id, level, gpa").eq("agency_id", agencyId),
    supabase.from("student_jp_exams").select("student_id, level, score, exam_type").eq("agency_id", agencyId),
  ]);
  res.json({
    education: eduRes.data || [],
    jp_exams: jpRes.data || [],
  });
}));

module.exports = router;
