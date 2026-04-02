const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

// GET /api/tasks — agency_id ফিল্টার সহ
router.get("/", checkPermission("tasks", "read"), asyncHandler(async (req, res) => {
  const { status, assigned_to, priority } = req.query;
  let query = supabase.from("tasks").select("*")
    .eq("agency_id", req.user.agency_id)
    .order("due_date");
  if (status && status !== "All") query = query.eq("status", status);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);
  if (priority && priority !== "All") query = query.eq("priority", priority);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST /api/tasks
router.post("/", checkPermission("tasks", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id, created_by: req.user.id };
  const { data, error } = await supabase.from("tasks").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — নতুন টাস্ক তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "tasks",
    recordId: data.id, description: `নতুন টাস্ক: ${data.title || ""}`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// PATCH /api/tasks/:id — agency_id চেক সহ
router.patch("/:id", checkPermission("tasks", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("tasks").select("updated_at").eq("id", req.params.id).single();
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
  const { data, error } = await supabase.from("tasks").update(payload)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — টাস্ক আপডেট (status change সহ)
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "tasks",
    recordId: req.params.id, description: `টাস্ক আপডেট: ${data.title || req.params.id}${req.body.status ? ` → ${req.body.status}` : ""}`, ip: req.ip }).catch(() => {});

  res.json(data);
}));

// DELETE /api/tasks/:id — agency_id চেক সহ
router.delete("/:id", checkPermission("tasks", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("tasks").delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — টাস্ক মুছে ফেলা
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "tasks",
    recordId: req.params.id, description: `টাস্ক মুছে ফেলা: ${req.params.id}`, ip: req.ip }).catch(() => {});

  res.json({ success: true });
}));

module.exports = router;
