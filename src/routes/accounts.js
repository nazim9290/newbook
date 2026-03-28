const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { generateId } = require("../lib/idGenerator");

const router = express.Router();
router.use(auth);

// GET /api/accounts/income — payments table থেকে income (student fee collections)
router.get("/income", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("created_at", { ascending: false });
  if (month) query = query.ilike("created_at", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  // payments → income format mapping
  const mapped = (data || []).map(p => ({
    ...p,
    date: p.created_at?.slice(0, 10) || "",
    studentName: p.students?.name_en || p.student_id || "—",
  }));
  res.json(mapped);
}));

// POST /api/accounts/income — payments table-এ insert (agency prefix receipt নম্বর সহ)
router.post("/income", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
  const receiptNo = req.body.receipt_no || await generateId(agencyId, "payment");
  const record = { ...req.body, agency_id: agencyId, receipt_no: receiptNo };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

// GET /api/accounts/expenses
router.get("/expenses", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;
  let query = supabase.from("expenses").select("*").eq("agency_id", req.user.agency_id).order("date", { ascending: false });
  if (month) query = query.ilike("date", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/accounts/expenses
router.post("/expenses", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("expenses").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

// GET /api/accounts/payments — student fee payments
router.get("/payments", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { student_id } = req.query;
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("date", { ascending: false });
  if (student_id) query = query.eq("student_id", student_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/accounts/payments
router.post("/payments", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

module.exports = router;
