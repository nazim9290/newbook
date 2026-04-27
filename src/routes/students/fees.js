/**
 * fees.js — Fee items + payment routes
 *
 * POST /:id/payments       — add payment (payments table)
 * POST /:id/fee-items      — add fee item (fee_items table — ফি কাঠামো)
 * GET  /:id/fee-items      — list fee structure
 * GET  /:id/payments-list  — list payments (date desc)
 */

const express = require("express");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const { logActivity } = require("../../lib/activityLog");
const cache = require("../../lib/cache");

const router = express.Router();
router.use(auth);

// POST /api/students/:id/payments — add payment (agency_id সহ)
router.post("/:id/payments", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .insert({
      ...req.body,
      student_id: req.params.id,
      agency_id: req.user.agency_id,
      date: req.body.date || new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — পেমেন্ট যোগ
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "payments",
    recordId: data.id, description: `পেমেন্ট যোগ: ৳${data.amount || 0} (${req.params.id})`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — payment যোগে revenue বদলায়
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// POST /api/students/:id/fee-items — add fee item (ফি কাঠামো)
router.post("/:id/fee-items", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { category, label, amount } = req.body;
  if (!category || !amount) return res.status(400).json({ error: "category ও amount দিন" });

  const { data, error } = await supabase
    .from("fee_items")
    .insert({ student_id: req.params.id, agency_id: req.user.agency_id, category, label: label || category, amount: Number(amount) })
    .select()
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// GET /api/students/:id/fee-items — student এর ফি কাঠামো
router.get("/:id/fee-items", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("fee_items")
    .select("*").eq("student_id", req.params.id).order("created_at");
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

// GET /api/students/:id/payments-list — student এর payments
router.get("/:id/payments-list", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("payments")
    .select("*").eq("student_id", req.params.id).order("date", { ascending: false });
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

module.exports = router;
