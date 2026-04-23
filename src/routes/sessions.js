/**
 * sessions.js — Sessions (intakes) master CRUD
 *
 * Per agency managed list of student intakes (e.g., "April 2027", "October 2027")
 * Used by: AddStudentForm, StudentDetailView, VisitorsPage — intake dropdown
 */

const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

// ── Allowed session columns — unknown keys drop ──
const ALLOWED = ["name", "country", "start_date", "end_date", "status", "notes"];
const sanitize = (body) => {
  const clean = {};
  for (const k of ALLOWED) if (body[k] !== undefined) clean[k] = body[k];
  return clean;
};

// ── GET /api/sessions — list (active by default; ?all=1 for archived too) ──
router.get("/", asyncHandler(async (req, res) => {
  let q = supabase.from("sessions").select("*").eq("agency_id", req.user.agency_id).order("name");
  if (req.query.all !== "1") q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data || []);
}));

// ── POST /api/sessions — নতুন session তৈরি ──
router.post("/", asyncHandler(async (req, res) => {
  const clean = sanitize(req.body);
  if (!clean.name || !String(clean.name).trim()) return res.status(400).json({ error: "Session name দিন" });
  clean.name = String(clean.name).trim();
  const payload = { ...clean, agency_id: req.user.agency_id };
  const { data, error } = await supabase.from("sessions").insert(payload).select().single();
  if (error) {
    if (error.message && error.message.includes("duplicate")) return res.status(400).json({ error: "এই নামের session আগে থেকেই আছে" });
    console.error("[DB]", error.message);
    return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "sessions",
    recordId: data.id, description: `Session: ${data.name}`, ip: req.ip }).catch(() => {});
  res.status(201).json(data);
}));

// ── PATCH /api/sessions/:id — update ──
router.patch("/:id", asyncHandler(async (req, res) => {
  const clean = sanitize(req.body);
  if (clean.name) clean.name = String(clean.name).trim();
  clean.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("sessions").update(clean)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// ── DELETE /api/sessions/:id — usage check first ──
router.delete("/:id", asyncHandler(async (req, res) => {
  // Get session name first (usage check করতে)
  const { data: ses } = await supabase.from("sessions").select("name")
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!ses) return res.status(404).json({ error: "Session পাওয়া যায়নি" });

  // ব্যবহার চেক — কোনো student-এ এই intake থাকলে delete নিষিদ্ধ
  const { data: used } = await supabase.from("students").select("id")
    .eq("agency_id", req.user.agency_id).eq("intake", ses.name).limit(1);
  if (used && used.length > 0) {
    return res.status(400).json({ error: `এই session-এ স্টুডেন্ট আছে — delete আগে archive করুন` });
  }

  const { error } = await supabase.from("sessions").delete()
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি" }); }
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "sessions",
    recordId: req.params.id, description: `Session deleted: ${ses.name}`, ip: req.ip }).catch(() => {});
  res.json({ success: true });
}));

module.exports = router;
