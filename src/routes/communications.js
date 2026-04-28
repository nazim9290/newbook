const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// Whitelist of patchable columns — frontend may not insert arbitrary keys.
const PATCH_COLS = ["type", "direction", "subject", "notes", "content", "follow_up_date", "duration_min"];
const sanitize = (body) => {
  const clean = {};
  for (const k of PATCH_COLS) if (body[k] !== undefined) clean[k] = body[k];
  // Empty-string date → NULL (Postgres date column rejects "")
  if (clean.follow_up_date === "") clean.follow_up_date = null;
  return clean;
};

// GET /api/communications — agency_id ফিল্টার সহ
router.get("/", checkPermission("communication", "read"), asyncHandler(async (req, res) => {
  const { student_id, visitor_id, type } = req.query;
  let q = supabase.from("communications")
    .select("*, students(name_en)")
    .eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false });
  if (student_id) q = q.eq("student_id", student_id);
  if (visitor_id) q = q.eq("visitor_id", visitor_id);
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST /api/communications — agency_id auto-set
router.post("/", checkPermission("communication", "write"), asyncHandler(async (req, res) => {
  const clean = sanitize(req.body);
  // student_id / visitor_id are not in PATCH_COLS (immutable after create)
  if (req.body.student_id !== undefined) clean.student_id = req.body.student_id || null;
  if (req.body.visitor_id !== undefined) clean.visitor_id = req.body.visitor_id || null;
  const { data, error } = await supabase.from("communications")
    .insert({ ...clean, agency_id: req.user.agency_id, logged_by: req.user.id })
    .select("*, students(name_en)").single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "create", module: "communications",
    recordId: data.id,
    description: `যোগাযোগ লগ: ${data.type || ""} — ${data.students?.name_en || data.student_id || ""}`,
    ip: req.ip,
  }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// PATCH /api/communications/:id — edit log entry (with optimistic lock)
router.patch("/:id", checkPermission("communication", "write"), asyncHandler(async (req, res) => {
  // Optimistic lock — concurrent edit protection
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("communications")
      .select("updated_at")
      .eq("id", req.params.id)
      .eq("agency_id", req.user.agency_id)
      .single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  const updates = sanitize(req.body);
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from("communications")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select("*, students(name_en)").single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  if (!data) return res.status(404).json({ error: "রেকর্ড পাওয়া যায়নি" });

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "update", module: "communications",
    recordId: req.params.id,
    description: `যোগাযোগ লগ আপডেট: ${data.students?.name_en || req.params.id}`,
    ip: req.ip,
  }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// DELETE /api/communications/:id — agency_id চেক সহ
router.delete("/:id", checkPermission("communication", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("communications")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "delete", module: "communications",
    recordId: req.params.id,
    description: `যোগাযোগ লগ মুছে ফেলা: ${req.params.id}`,
    ip: req.ip,
  }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

module.exports = router;
