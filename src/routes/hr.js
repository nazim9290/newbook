const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

// GET /api/hr/employees
router.get("/employees", checkPermission("hr", "read"), asyncHandler(async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("employees").select("*").eq("agency_id", req.user.agency_id).order("name");
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(decryptMany(data));
}));

// POST /api/hr/employees
router.post("/employees", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("employees").insert(encryptSensitiveFields(record)).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — নতুন কর্মচারী তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "hr",
    recordId: data.id, description: `নতুন কর্মচারী: ${data.name || ""}`, ip: req.ip }).catch(() => {});

  res.status(201).json(decryptSensitiveFields(data));
}));

// PATCH /api/hr/employees/:id
router.patch("/employees/:id", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("employees").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  const payload = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("employees").update(encryptSensitiveFields(payload)).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — কর্মচারী আপডেট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "hr",
    recordId: req.params.id, description: `কর্মচারী আপডেট: ${data.name || req.params.id}`, ip: req.ip }).catch(() => {});

  res.json(decryptSensitiveFields(data));
}));

// GET /api/hr/salary?employee_id=xxx&month=2026-03
router.get("/salary", checkPermission("hr", "read"), asyncHandler(async (req, res) => {
  const { employee_id, month } = req.query;
  let query = supabase.from("salary_history").select("*, employees(name)").eq("agency_id", req.user.agency_id).order("paid_date", { ascending: false });
  if (employee_id) query = query.eq("employee_id", employee_id);
  if (month) query = query.eq("month", month);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/hr/salary — pay salary
router.post("/salary", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("salary_history").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — বেতন দেওয়া
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "hr",
    recordId: data.id, description: `বেতন প্রদান: ৳${data.amount || 0} (${data.month || ""})`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// ══════════════════════════════════════
// ছুটি (Leave) Management
// ══════════════════════════════════════

// GET /api/hr/leaves — ছুটির তালিকা
router.get("/leaves", checkPermission("hr", "read"), asyncHandler(async (req, res) => {
  const { employee_id, status, month } = req.query;
  let query = supabase.from("leaves").select("*, employees(name)").eq("agency_id", req.user.agency_id).order("start_date", { ascending: false });
  if (employee_id) query = query.eq("employee_id", employee_id);
  if (status && status !== "All") query = query.eq("status", status);
  if (month) query = query.gte("start_date", `${month}-01`).lte("start_date", `${month}-31`);
  const { data, error } = await query;
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  res.json(data || []);
}));

// POST /api/hr/leaves — নতুন ছুটি আবেদন
router.post("/leaves", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const { employee_id, type, start_date, end_date, reason } = req.body;
  if (!employee_id || !start_date || !end_date) return res.status(400).json({ error: "কর্মচারী, শুরু ও শেষ তারিখ দিন" });
  // দিন সংখ্যা হিসাব
  const days = Math.max(1, Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
  const { data, error } = await supabase.from("leaves").insert({
    agency_id: req.user.agency_id, employee_id, type: type || "casual",
    start_date, end_date, days, reason: reason || "", status: "pending",
  }).select("*, employees(name)").single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

// PATCH /api/hr/leaves/:id — ছুটি অনুমোদন/বাতিল
router.patch("/leaves/:id", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("leaves").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  const updates = {};
  if (req.body.status) {
    updates.status = req.body.status;
    if (req.body.status === "approved") { updates.approved_by = req.user.id; updates.approved_at = new Date().toISOString(); }
  }
  if (req.body.notes !== undefined) updates.notes = req.body.notes;
  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("leaves").update(updates)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select("*, employees(name)").single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি" }); }
  res.json(data);
}));

// DELETE /api/hr/leaves/:id — ছুটি মুছুন
router.delete("/leaves/:id", checkPermission("hr", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("leaves").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি" }); }
  res.json({ success: true });
}));

module.exports = router;
