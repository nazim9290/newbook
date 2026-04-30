/**
 * branches.js — Branch Management API
 *
 * এজেন্সির শাখা CRUD — ঠিকানা, ফোন, ম্যানেজার সহ।
 * Excel system variable-এ branch address ব্যবহার হয়।
 *
 * Reads stay open — every form / branch dropdown needs the list.
 * Writes/deletes are gated to "settings" permission (owner only by default).
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const cache = require("../lib/cache");
const router = express.Router();
router.use(auth);

// GET /api/branches — সব branch তালিকা
router.get("/", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("branches")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("is_hq", { ascending: false }); // HQ আগে
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data || []);
}));

// GET /api/branches/:id
router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("branches")
    .select("*").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (error) return res.status(404).json({ error: "Branch পাওয়া যায়নি" });
  res.json(data);
}));

// POST /api/branches — নতুন branch
router.post("/", checkPermission("settings", "write"), asyncHandler(async (req, res) => {
  const { name, name_bn, city, address, address_bn, phone, email, manager, is_hq } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Branch নাম দিন" });

  const { data, error } = await supabase.from("branches").insert({
    agency_id: req.user.agency_id,
    name: name.trim(), name_bn, city, address, address_bn,
    phone, email, manager, is_hq: !!is_hq,
  }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: error.message?.includes("unique") ? "এই নামে branch আছে" : "সার্ভার ত্রুটি" }); }

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "branches",
    recordId: data.id, description: `নতুন branch: ${data.name}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// PATCH /api/branches/:id
router.patch("/:id", checkPermission("settings", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("branches").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন", code: "CONFLICT" });
    }
  }

  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("branches")
    .update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "branches",
    recordId: req.params.id, description: `Branch আপডেট: ${data?.name || req.params.id}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// DELETE /api/branches/:id
router.delete("/:id", checkPermission("settings", "delete"), asyncHandler(async (req, res) => {
  // Capture name first for activity log
  const { data: existing } = await supabase.from("branches")
    .select("name").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();

  const { error } = await supabase.from("branches")
    .delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "branches",
    recordId: req.params.id, description: `Branch মুছে ফেলা: ${existing?.name || req.params.id}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

// GET /api/branches/by-name/:name — নাম দিয়ে branch খুঁজো (Excel system var-এ ব্যবহার)
router.get("/by-name/:name", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("branches")
    .select("*").eq("agency_id", req.user.agency_id).eq("name", req.params.name).single();
  res.json(data || null);
}));

module.exports = router;
