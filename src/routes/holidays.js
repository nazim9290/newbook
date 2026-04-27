/**
 * holidays.js — সরকারি ছুটি ম্যানেজমেন্ট API
 *
 * এজেন্সি-ভিত্তিক ছুটির তালিকা CRUD।
 * ব্যাচ hours calculation-এ এই ছুটির দিনগুলো auto-exclude হয়।
 * recurring = true হলে প্রতিবছর একই তারিখে ছুটি (যেমন ভাষা দিবস ২১ ফেব্রুয়ারি)।
 *
 * Endpoints:
 *   GET    /api/holidays         — এজেন্সির সব ছুটি (তারিখ অনুযায়ী sorted)
 *   POST   /api/holidays         — নতুন ছুটি যোগ
 *   PATCH  /api/holidays/:id     — ছুটি আপডেট
 *   DELETE /api/holidays/:id     — ছুটি মুছে ফেলা
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();

// সব endpoint-এ auth লাগবে — JWT token থেকে agency_id পাওয়া যায়
router.use(auth);

// ── GET /api/holidays — এজেন্সির সব ছুটি আনো (তারিখ অনুযায়ী) ──
router.get("/", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("holidays")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("date");
  if (error) {
    console.error("[Holidays GET]", error.message);
    return res.status(500).json({ error: "ছুটির তালিকা লোড করতে সমস্যা হয়েছে" });
  }
  res.json(data || []);
}));

// ── POST /api/holidays — নতুন ছুটি যোগ ──
router.post("/", asyncHandler(async (req, res) => {
  const { date, name, name_bn, recurring } = req.body;

  // Validation — তারিখ ও নাম আবশ্যক
  if (!date || !name) {
    return res.status(400).json({ error: "তারিখ ও ছুটির নাম আবশ্যক" });
  }

  const { data, error } = await supabase
    .from("holidays")
    .insert({
      agency_id: req.user.agency_id,
      date,
      name,
      name_bn: name_bn || null,
      recurring: recurring || false,
    })
    .select()
    .single();

  if (error) {
    console.error("[Holidays POST]", error.message);
    // Duplicate date check — unique index violation
    if (error.message.includes("duplicate") || error.code === "23505") {
      return res.status(409).json({ error: "এই তারিখে ইতিমধ্যে একটি ছুটি আছে" });
    }
    return res.status(400).json({ error: "ছুটি যোগ করতে সমস্যা হয়েছে" });
  }

  // Activity log — নতুন ছুটি যোগ
  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "create", module: "holidays",
    recordId: data.id, description: `নতুন ছুটি: ${name} (${date})`,
    ip: req.ip,
  }).catch(() => {});

  res.status(201).json(data);
}));

// ── PATCH /api/holidays/:id — ছুটি আপডেট ──
router.patch("/:id", asyncHandler(async (req, res) => {
  const { date, name, name_bn, recurring } = req.body;
  const updates = {};
  if (date !== undefined) updates.date = date;
  if (name !== undefined) updates.name = name;
  if (name_bn !== undefined) updates.name_bn = name_bn;
  if (recurring !== undefined) updates.recurring = recurring;

  const { data, error } = await supabase
    .from("holidays")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();

  if (error) {
    console.error("[Holidays PATCH]", error.message);
    return res.status(400).json({ error: "ছুটি আপডেট করতে সমস্যা হয়েছে" });
  }

  // Activity log — ছুটি আপডেট
  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "update", module: "holidays",
    recordId: req.params.id, description: `ছুটি আপডেট: ${data.name || req.params.id}`,
    ip: req.ip,
  }).catch(() => {});

  res.json(data);
}));

// ── DELETE /api/holidays/:id — ছুটি মুছে ফেলো ──
router.delete("/:id", asyncHandler(async (req, res) => {
  // আগে নামটা নিয়ে রাখো activity log-এর জন্য
  const { data: existing } = await supabase
    .from("holidays")
    .select("name")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();

  const { error } = await supabase
    .from("holidays")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);

  if (error) {
    console.error("[Holidays DELETE]", error.message);
    return res.status(400).json({ error: "ছুটি মুছতে সমস্যা হয়েছে" });
  }

  // Activity log — ছুটি মুছে ফেলা
  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "delete", module: "holidays",
    recordId: req.params.id, description: `ছুটি মুছে ফেলা হয়েছে: ${existing?.name || req.params.id}`,
    ip: req.ip,
  }).catch(() => {});

  res.json({ success: true });
}));

module.exports = router;
