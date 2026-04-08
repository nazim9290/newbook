const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const router = express.Router();
router.use(auth);

// GET — সব authenticated user agent list পড়তে পারবে (dropdown/reference-এর জন্য)
router.get("/", asyncHandler(async (req, res) => {
  const { status } = req.query;
  let q = supabase.from("agents").select("*").eq("agency_id", req.user.agency_id).order("name");
  if (status && status !== "All") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // প্রতি agent-এ রেফার করা students count ও তালিকা যোগ
  if (data && data.length > 0) {
    try {
      const agentIds = data.map(a => a.id);
      const { data: referred } = await supabase.from("students")
        .select("id, name_en, agent_id, status")
        .in("agent_id", agentIds);
      // agent-ভিত্তিক group
      data.forEach(a => {
        a.students = (referred || []).filter(s => s.agent_id === a.id);
      });
    } catch { data.forEach(a => { a.students = []; }); }
  }

  res.json(data);
}));

router.post("/", checkPermission("agents", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("agents").insert({ ...req.body, agency_id: req.user.agency_id }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

router.patch("/:id", checkPermission("agents", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("agents").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  const updates = { ...req.body, updated_at: new Date().toISOString() };

  const { data, error } = await supabase.from("agents").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

router.delete("/:id", checkPermission("agents", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("agents").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ success: true });
}));

module.exports = router;
