/**
 * billing.js — Invoice & Payment API (Phase 1: read-only)
 *
 * Master Plan v1.0 Section 7.1। Phase 1-এ:
 *   GET  /api/billing/invoices              — agency-র সব invoices (পেজিনেটেড)
 *   GET  /api/billing/invoices/:id          — invoice detail + line items + linked payments
 *   GET  /api/billing/invoices/:id/pdf      — placeholder (Phase 3-এ pdfkit/puppeteer)
 *   GET  /api/billing/payments              — agency-র সব payment history
 *   GET  /api/billing/summary               — outstanding total / paid YTD / next bill
 *
 * Note: subscription_payments table — student fees-এর `payments` থেকে আলাদা।
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();

router.use(auth);

// ── GET /invoices — list (most-recent first), filterable by status ──
router.get("/invoices", asyncHandler(async (req, res) => {
  const { status, from, to, limit = 50 } = req.query;
  let q = supabase.from("invoices").select("*", { count: "exact" })
    .eq("agency_id", req.user.agency_id)
    .order("issue_date", { ascending: false })
    .limit(Math.min(Number(limit) || 50, 200));
  if (status && status !== "All") q = q.eq("status", status);
  if (from) q = q.gte("issue_date", from);
  if (to) q = q.lte("issue_date", to);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: "Invoices লোড ব্যর্থ" });
  res.json({ data: data || [], total: count || 0 });
}));

// ── GET /invoices/:id — detail + payments ──
router.get("/invoices/:id", asyncHandler(async (req, res) => {
  const { data: inv, error } = await supabase.from("invoices")
    .select("*").eq("agency_id", req.user.agency_id).eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Invoice লোড ব্যর্থ" });
  if (!inv) return res.status(404).json({ error: "Invoice পাওয়া যায়নি" });

  // Linked payments
  const { data: payments } = await supabase.from("subscription_payments")
    .select("*").eq("invoice_id", inv.id).order("paid_at", { ascending: false });

  res.json({ invoice: inv, payments: payments || [] });
}));

// ── GET /invoices/:id/pdf — Phase 1 placeholder ──
router.get("/invoices/:id/pdf", asyncHandler(async (req, res) => {
  // Phase 3-এ pdfkit/puppeteer দিয়ে generate হবে
  res.status(501).json({ error: "PDF generation Phase 3-এ available হবে", code: "NOT_IMPLEMENTED" });
}));

// ── GET /payments — payment history ──
router.get("/payments", asyncHandler(async (req, res) => {
  const { from, to, method, limit = 100 } = req.query;
  let q = supabase.from("subscription_payments").select("*", { count: "exact" })
    .eq("agency_id", req.user.agency_id)
    .order("paid_at", { ascending: false })
    .limit(Math.min(Number(limit) || 100, 500));
  if (method && method !== "All") q = q.eq("payment_method", method);
  if (from) q = q.gte("paid_at", from);
  if (to) q = q.lte("paid_at", to);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: "Payments লোড ব্যর্থ" });
  res.json({ data: data || [], total: count || 0 });
}));

// ── GET /summary — quick KPI: outstanding / paid YTD / next bill ──
router.get("/summary", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;

  // Outstanding (sent / overdue)
  const { data: outstandingRows } = await supabase.from("invoices")
    .select("total_amount, paid_amount").eq("agency_id", agencyId).in("status", ["sent", "overdue"]);
  const outstanding = (outstandingRows || []).reduce((sum, r) => sum + (Number(r.total_amount) - Number(r.paid_amount)), 0);

  // Paid YTD (Bangladesh fiscal year — calendar year here for simplicity)
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const { data: ytdRows } = await supabase.from("subscription_payments")
    .select("amount").eq("agency_id", agencyId).eq("status", "completed").gte("paid_at", yearStart);
  const paidYtd = (ytdRows || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);

  // Last & next bill (from subscription)
  const { data: sub } = await supabase.from("agency_subscriptions")
    .select("current_period_end, billing_cycle, status").eq("agency_id", agencyId).maybeSingle();

  res.json({
    outstanding_amount: outstanding,
    paid_ytd: paidYtd,
    next_bill_date: sub?.current_period_end || null,
    billing_cycle: sub?.billing_cycle || null,
    status: sub?.status || null,
    currency: "BDT",
  });
}));

module.exports = router;
