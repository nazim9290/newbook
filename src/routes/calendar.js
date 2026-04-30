const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const cache = require("../lib/cache");
const { getBranchFilter } = require("../lib/branchFilter");
const router = express.Router();
router.use(auth);

// ── allowed calendar_events columns — unknown keys drop (security + schema safety) ──
const ALLOWED_FIELDS = [
  "title", "date", "time", "end_time", "type", "description",
  "student_id",           // legacy single-student (backward compat)
  "student_ids",          // TEXT[] — নতুন multi-student
  "staff_ids",            // UUID[] — নতুন multi-staff
  "branches",             // TEXT[] — নতুন multi-branch (empty = সব branch)
];

// req.body থেকে শুধু allowed fields পরিষ্কার করে নেওয়া
function sanitizeBody(body) {
  const clean = {};
  for (const k of ALLOWED_FIELDS) {
    if (body[k] !== undefined) clean[k] = body[k];
  }
  return clean;
}

// ── GET /calendar — branch filtering সহ event list ──
// Admin / Owner / HQ staff → সব event দেখে
// Regular staff → শুধু তাদের branch-এর event (branches = {} মানে সবার জন্য)
router.get("/", checkPermission("calendar", "read"), asyncHandler(async (req, res) => {
  const { month, type } = req.query;
  // Server-side LIMIT 1000 guard — calendar grows over years; cap defensively
  const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  let q = supabase.from("calendar_events").select("*, students(name_en)")
    .eq("agency_id", req.user.agency_id).order("date")
    .range(offset, offset + limit - 1);
  if (month) q = q.gte("date", month + "-01").lte("date", month + "-31");
  if (type && type !== "All") q = q.eq("type", type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // Branch filter — role + HQ ভিত্তিক (Node-side filter কারণ custom wrapper array operator সাপোর্ট করে না)
  const userBranch = getBranchFilter(req.user);
  let filtered = data || [];
  if (userBranch) {
    filtered = filtered.filter(ev => {
      const branches = Array.isArray(ev.branches) ? ev.branches : [];
      // empty branches = সব branch visible (agency-wide event)
      if (branches.length === 0) return true;
      return branches.includes(userBranch);
    });
  }
  res.json(filtered);
}));

// ── POST /calendar — নতুন event তৈরি ──
router.post("/", checkPermission("calendar", "write"), asyncHandler(async (req, res) => {
  const clean = sanitizeBody(req.body);
  const payload = { ...clean, agency_id: req.user.agency_id, created_by: req.user.id };
  const { data, error } = await supabase.from("calendar_events").insert(payload).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "calendar",
    recordId: data.id, description: `নতুন ইভেন্ট: ${data.title || ""} (${data.date || ""})`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// ── PATCH /calendar/:id — optimistic lock সহ update ──
router.patch("/:id", checkPermission("calendar", "write"), asyncHandler(async (req, res) => {
  // Optimistic lock — frontend updated_at পাঠালে check করো
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("calendar_events").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // Sanitize + updated_at refresh
  const clean = sanitizeBody(req.body);
  const payload = { ...clean, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("calendar_events").update(payload)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "calendar",
    recordId: req.params.id, description: `ইভেন্ট আপডেট: ${data?.title || req.params.id}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

router.delete("/:id", checkPermission("calendar", "delete"), asyncHandler(async (req, res) => {
  // Capture title for activity log before delete
  const { data: existing } = await supabase.from("calendar_events").select("title, date")
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();

  const { error } = await supabase.from("calendar_events").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "calendar",
    recordId: req.params.id, description: `ইভেন্ট মুছে ফেলা: ${existing?.title || req.params.id}${existing?.date ? ` (${existing.date})` : ""}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

module.exports = router;
