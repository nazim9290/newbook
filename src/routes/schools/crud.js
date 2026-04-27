/**
 * crud.js — Schools CRUD routes
 *
 * GET    /            — list (search, filter, cursor pagination)
 * POST   /            — create (numeric sanitize + boolean normalize)
 * PATCH  /:id         — update (optimistic lock)
 * DELETE /:id         — delete
 */

const express = require("express");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const { logActivity } = require("../../lib/activityLog");
const cache = require("../../lib/cache");
const { dbError, sanitizeNumerics } = require("../../lib/dbError");
const { NUMERIC_COLS, SCHOOL_COLS } = require("./_shared");

const router = express.Router();
router.use(auth);

// GET /api/schools — search, filter, cursor-based pagination
router.get("/", checkPermission("schools", "read"), asyncHandler(async (req, res) => {
  const { country, search } = req.query;
  const { applyCursor, buildResponse } = require("../../lib/cursorPagination");

  let query = supabase.from("schools").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (search) {
    query = query.or(`name_en.ilike.%${search}%,name_jp.ilike.%${search}%,city.ilike.%${search}%`);
  }
  if (country && country !== "All") query = query.eq("country", country);

  query = applyCursor(query, req.query, { sortCol: "name_en", ascending: true });

  const { data, error, count } = await query;
  if (error) return dbError(res, error, "schools.list", 500);
  res.json(buildResponse(data || [], req.query, { sortCol: "name_en", total: count }));
}));

// POST /api/schools — নতুন স্কুল (numeric fields sanitize সহ)
router.post("/", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  // শুধু valid columns রাখো, numeric fields convert করো
  const record = { agency_id: req.user.agency_id };
  for (const col of SCHOOL_COLS) {
    if (req.body[col] !== undefined && req.body[col] !== "") record[col] = req.body[col];
  }
  const sanitized = sanitizeNumerics(record, NUMERIC_COLS);

  // boolean field
  if (req.body.has_dormitory !== undefined) sanitized.has_dormitory = !!req.body.has_dormitory;

  const { data, error } = await supabase.from("schools").insert(sanitized).select().single();
  if (error) return dbError(res, error, "schools.create");

  // Cache invalidate — নতুন স্কুল তৈরি হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — নতুন স্কুল তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "schools",
    recordId: data.id, description: `নতুন স্কুল: ${data.name_en || ""}`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// PATCH /api/schools/:id
router.patch("/:id", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("schools").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  const updates = {};
  for (const col of SCHOOL_COLS) {
    if (req.body[col] !== undefined) updates[col] = req.body[col];
  }
  const sanitized = sanitizeNumerics(updates, NUMERIC_COLS);
  if (req.body.has_dormitory !== undefined) sanitized.has_dormitory = !!req.body.has_dormitory;

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  sanitized.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from("schools").update(sanitized)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.update");

  // Cache invalidate — স্কুল আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — স্কুল আপডেট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "schools",
    recordId: req.params.id, description: `স্কুল আপডেট: ${data.name_en || req.params.id}`, ip: req.ip }).catch(() => {});

  res.json(data);
}));

// DELETE /api/schools/:id
router.delete("/:id", checkPermission("schools", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("schools").delete()
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return dbError(res, error, "schools.delete");

  // Cache invalidate — স্কুল মুছে ফেলা হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — স্কুল মুছে ফেলা
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "schools",
    recordId: req.params.id, description: `স্কুল মুছে ফেলা: ${req.params.id}`, ip: req.ip }).catch(() => {});

  res.json({ success: true });
}));

module.exports = router;
