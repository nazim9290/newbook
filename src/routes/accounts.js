const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { generateId } = require("../lib/idGenerator");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// GET /api/accounts/income — payments table থেকে income (student fee collections)
router.get("/income", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;

  // পেজিনেশন প্যারামিটার — ডিফল্ট page=1, limit=50, সর্বোচ্চ ৫০০
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  // মোট রেকর্ড সংখ্যা বের করতে count query
  let countQuery = supabase.from("payments").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (month) countQuery = countQuery.ilike("created_at", `${month}%`);
  if (branch && branch !== "All") countQuery = countQuery.eq("branch", branch);
  countQuery = countQuery.limit(0);
  const { count: total, error: countError } = await countQuery;
  if (countError) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেটেড ডেটা query
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (month) query = query.ilike("created_at", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // payments → income format mapping
  const mapped = (data || []).map(p => ({
    ...p,
    date: p.created_at ? (p.created_at instanceof Date ? p.created_at.toISOString().slice(0, 10) : String(p.created_at).slice(0, 10)) : "",
    studentName: p.students?.name_en || p.student_id || "—",
  }));

  // পেজিনেশন সহ response
  res.json({ data: mapped, total: total || 0, page, limit });
}));

// POST /api/accounts/income — payments table-এ insert (agency prefix receipt নম্বর সহ)
router.post("/income", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
  const receiptNo = req.body.receipt_no || await generateId(agencyId, "payment");
  const record = { ...req.body, agency_id: agencyId, receipt_no: receiptNo };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // ক্যাশ invalidate — income যোগে revenue বদলায়
  cache.invalidate(agencyId);

  res.status(201).json(data);
}));

// GET /api/accounts/expenses
router.get("/expenses", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;

  // পেজিনেশন প্যারামিটার — ডিফল্ট page=1, limit=50, সর্বোচ্চ ৫০০
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  // মোট রেকর্ড সংখ্যা বের করতে count query
  let countQuery = supabase.from("expenses").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (month) countQuery = countQuery.ilike("date", `${month}%`);
  if (branch && branch !== "All") countQuery = countQuery.eq("branch", branch);
  countQuery = countQuery.limit(0);
  const { count: total, error: countError } = await countQuery;
  if (countError) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেটেড ডেটা query
  let query = supabase.from("expenses").select("*").eq("agency_id", req.user.agency_id).order("date", { ascending: false }).range(offset, offset + limit - 1);
  if (month) query = query.ilike("date", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেশন সহ response
  res.json({ data, total: total || 0, page, limit });
}));

// POST /api/accounts/expenses
router.post("/expenses", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const { note, notes, ...rest } = req.body;
  const record = { ...rest, description: note || notes || rest.description || null, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  // Empty string date → null
  if (record.date === "") record.date = null;
  // Remove fields that don't exist in expenses table
  delete record.note; delete record.notes;
  const { data, error } = await supabase.from("expenses").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // ক্যাশ invalidate — expense যোগে dashboard expense বদলায়
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// GET /api/accounts/payments — student fee payments
router.get("/payments", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { student_id } = req.query;

  // পেজিনেশন প্যারামিটার — ডিফল্ট page=1, limit=50, সর্বোচ্চ ৫০০
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  // মোট রেকর্ড সংখ্যা বের করতে count query
  let countQuery = supabase.from("payments").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (student_id) countQuery = countQuery.eq("student_id", student_id);
  countQuery = countQuery.limit(0);
  const { count: total, error: countError } = await countQuery;
  if (countError) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেটেড ডেটা query
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("date", { ascending: false }).range(offset, offset + limit - 1);
  if (student_id) query = query.eq("student_id", student_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেশন সহ response
  res.json({ data, total: total || 0, page, limit });
}));

// POST /api/accounts/payments
router.post("/payments", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // ক্যাশ invalidate — payment যোগে revenue/dues বদলায়
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

module.exports = router;
