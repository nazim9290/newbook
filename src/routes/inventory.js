/**
 * inventory.js — ইনভেন্টরি (সম্পদ ও মালামাল) CRUD API
 *
 * Endpoints:
 *   GET    /              — সব inventory item আনো (agency-scoped)
 *   POST   /              — নতুন item যোগ
 *   PATCH  /:id           — item আপডেট (condition/quantity/info)
 *   DELETE /:id           — item মুছে ফেলো (hard delete)
 *   PATCH  /:id/condition — শুধু condition/status আপডেট
 *
 * DB Table: inventory
 *   id, agency_id, name, category, quantity, unit_price, branch,
 *   condition, status, brand, model, vendor, location,
 *   purchase_date, warranty, assigned_to, notes,
 *   created_at, updated_at
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const router = express.Router();
router.use(auth);

// ── Allowed fields — শুধু এই fields DB-তে যাবে (injection প্রতিরোধ) ──
const ALLOWED_FIELDS = [
  "name", "category", "quantity", "unit_price", "branch",
  "condition", "status", "brand", "model", "vendor", "location",
  "purchase_date", "warranty", "assigned_to", "notes",
];

/** body থেকে শুধু allowed fields বের করো — বাকি সব বাদ */
function pickFields(body) {
  const clean = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) clean[key] = body[key];
  }
  // condition আসলে status-এও কপি করো (frontend দুটোই ব্যবহার করে)
  if (clean.condition && !clean.status) clean.status = clean.condition;
  if (clean.status && !clean.condition) clean.condition = clean.status;
  // updated_at auto-set
  clean.updated_at = new Date().toISOString();
  return clean;
}

// ═══════════════════════════════════════════════════════
// GET / — সব inventory item (agency-scoped, name অনুযায়ী sorted)
// ═══════════════════════════════════════════════════════
router.get("/", checkPermission("inventory", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("inventory")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("name");
  if (error) {
    console.error("[Inventory GET]", error.message);
    return res.status(500).json({ error: "ইনভেন্টরি লোড করতে সমস্যা হয়েছে" });
  }
  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// POST / — নতুন item তৈরি
// ═══════════════════════════════════════════════════════
router.post("/", checkPermission("inventory", "write"), asyncHandler(async (req, res) => {
  const fields = pickFields(req.body);
  if (!fields.name || !fields.name.trim()) {
    return res.status(400).json({ error: "সম্পদের নাম দিতে হবে" });
  }
  fields.agency_id = req.user.agency_id;

  const { data, error } = await supabase
    .from("inventory")
    .insert(fields)
    .select()
    .single();
  if (error) {
    console.error("[Inventory POST]", error.message);
    return res.status(400).json({ error: "আইটেম যোগ করতে সমস্যা হয়েছে" });
  }
  res.status(201).json(data);
}));

// ═══════════════════════════════════════════════════════
// PATCH /:id — item আপডেট (যেকোনো field)
// ═══════════════════════════════════════════════════════
router.patch("/:id", checkPermission("inventory", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("inventory").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  const fields = pickFields(req.body);
  if (Object.keys(fields).length <= 1) {
    // শুধু updated_at আছে — আসলে কোনো পরিবর্তন নেই
    return res.status(400).json({ error: "আপডেট করার মতো কিছু পাওয়া যায়নি" });
  }

  const { data, error } = await supabase
    .from("inventory")
    .update(fields)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();
  if (error) {
    console.error("[Inventory PATCH]", error.message);
    return res.status(400).json({ error: "আপডেট করতে সমস্যা হয়েছে" });
  }
  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// PATCH /:id/condition — শুধু condition/status পরিবর্তন
// ═══════════════════════════════════════════════════════
router.patch("/:id/condition", checkPermission("inventory", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("inventory").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  const { condition } = req.body;
  if (!condition) {
    return res.status(400).json({ error: "condition দিতে হবে" });
  }

  const { data, error } = await supabase
    .from("inventory")
    .update({ condition, status: condition, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();
  if (error) {
    console.error("[Inventory Condition]", error.message);
    return res.status(400).json({ error: "অবস্থা আপডেট করতে সমস্যা হয়েছে" });
  }
  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// DELETE /:id — item মুছে ফেলো (hard delete)
// ═══════════════════════════════════════════════════════
router.delete("/:id", checkPermission("inventory", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from("inventory")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) {
    console.error("[Inventory DELETE]", error.message);
    return res.status(400).json({ error: "মুছতে সমস্যা হয়েছে" });
  }
  res.json({ success: true });
}));

module.exports = router;
