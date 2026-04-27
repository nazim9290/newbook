/**
 * submissions.js — School submission history routes
 *
 * GET   /:id/submissions        — school-এর সব submission list
 * POST  /:id/submissions        — নতুন submission add
 * PATCH /submissions/:subId     — single submission update
 */

const express = require("express");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const cache = require("../../lib/cache");
const { dbError } = require("../../lib/dbError");

const router = express.Router();
router.use(auth);

// GET /api/schools/:id/submissions
router.get("/:id/submissions", checkPermission("schools", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions")
    .select("*, students(name_en, phone, status)")
    .eq("school_id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .order("submission_date", { ascending: false });
  if (error) return dbError(res, error, "schools.submissions", 500);
  res.json(data);
}));

// POST /api/schools/:id/submissions
router.post("/:id/submissions", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions")
    .insert({ ...req.body, school_id: req.params.id, agency_id: req.user.agency_id })
    .select().single();
  if (error) return dbError(res, error, "schools.addSubmission");

  // Cache invalidate — submission যোগ হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// PATCH /api/schools/submissions/:subId
router.patch("/submissions/:subId", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("submissions").update(req.body)
    .eq("id", req.params.subId).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.updateSubmission");

  // Cache invalidate — submission আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

module.exports = router;
