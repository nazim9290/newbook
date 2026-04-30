const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const { generateId } = require("../lib/idGenerator");
const cache = require("../lib/cache");
const { getBranchFilter } = require("../lib/branchFilter");

const router = express.Router();
router.use(auth);

// GET /api/accounts/income — payments table থেকে income (student fee collections)
router.get("/income", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;
  // month format validation — YYYY-MM (SQL injection prevention)
  if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Invalid month format (YYYY-MM)" });

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

  // Cursor-based pagination
  const { applyCursor, buildResponse } = require("../lib/cursorPagination");
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id);
  if (month) query = query.ilike("created_at", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  query = applyCursor(query, req.query, { sortCol: "created_at", ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  const mapped = (data || []).map(p => ({
    ...p,
    date: p.created_at ? (p.created_at instanceof Date ? p.created_at.toISOString().slice(0, 10) : String(p.created_at).slice(0, 10)) : "",
    studentName: p.students?.name_en || p.student_id || "—",
  }));

  res.json(buildResponse(mapped, req.query, { sortCol: "created_at", total: total || 0 }));
}));

// POST /api/accounts/income — payments table-এ insert (agency prefix receipt নম্বর সহ)
router.post("/income", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
  const receiptNo = req.body.receipt_no || await generateId(agencyId, "payment");
  const record = { ...req.body, agency_id: agencyId, receipt_no: receiptNo };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — আয় যোগ
  logActivity({ agencyId, userId: req.user.id, action: "create", module: "accounts",
    recordId: data.id, description: `আয় যোগ: ৳${data.amount || 0}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — income যোগে revenue বদলায়
  cache.invalidate(agencyId);

  res.status(201).json(data);
}));

// GET /api/accounts/expenses
router.get("/expenses", checkPermission("accounts", "read"), asyncHandler(async (req, res) => {
  const { month, branch } = req.query;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Invalid month format (YYYY-MM)" });

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

  // Cursor-based pagination
  const { applyCursor, buildResponse } = require("../lib/cursorPagination");
  let query = supabase.from("expenses").select("*").eq("agency_id", req.user.agency_id);
  if (month) query = query.ilike("date", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  query = applyCursor(query, req.query, { sortCol: "date", ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  res.json(buildResponse(data || [], req.query, { sortCol: "date", total: total || 0 }));
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

  // Activity log — খরচ যোগ
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "accounts",
    recordId: data.id, description: `খরচ যোগ: ৳${data.amount || 0} — ${data.category || ""}`, ip: req.ip }).catch(() => {});

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

  // Branch filter — staff শুধু নিজ branch-এর payments দেখবে
  const branchFilter = getBranchFilter(req.user);

  // মোট রেকর্ড সংখ্যা বের করতে count query
  let countQuery = supabase.from("payments").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (student_id) countQuery = countQuery.eq("student_id", student_id);
  if (branchFilter) countQuery = countQuery.eq("branch", branchFilter);
  countQuery = countQuery.limit(0);
  const { count: total, error: countError } = await countQuery;
  if (countError) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // Cursor-based pagination
  const { applyCursor: ac, buildResponse: br } = require("../lib/cursorPagination");
  let query = supabase.from("payments").select("*, students(name_en)").eq("agency_id", req.user.agency_id);
  if (student_id) query = query.eq("student_id", student_id);
  if (branchFilter) query = query.eq("branch", branchFilter);
  query = ac(query, req.query, { sortCol: "date", ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  res.json(br(data || [], req.query, { sortCol: "date", total: total || 0 }));
}));

// POST /api/accounts/payments
router.post("/payments", checkPermission("accounts", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — পেমেন্ট যোগ
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "payments",
    recordId: data.id, description: `পেমেন্ট যোগ: ৳${data.amount || 0}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — payment যোগে revenue/dues বদলায়
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// ═══════════════════════════════════════════════════════
// PATCH + DELETE — error correction path for accountants
// ═══════════════════════════════════════════════════════
// /income, /payments both store in `payments` table; /expenses in `expenses`.
// All three need the same optimistic-lock + activity-log + cache-invalidate
// pattern to be safe in a multi-tenant, multi-staff environment.

// Whitelisted columns for PATCH (drop unknown keys silently)
const PAYMENT_PATCH_COLS = ["amount", "category", "date", "method", "note", "notes", "receipt_no", "student_id", "branch", "tax_amount", "discount"];
const EXPENSE_PATCH_COLS = ["amount", "category", "description", "date", "paid_by", "branch", "receipt_url"];

const sanitize = (cols, body) => {
  const clean = {};
  for (const k of cols) if (body[k] !== undefined) clean[k] = body[k];
  if (clean.date === "") clean.date = null;   // Postgres date column rejects ""
  return clean;
};

// Shared PATCH handler — table = "payments" or "expenses", cols = whitelist, label = activity-log noun
const patchHandler = (table, cols, label) => asyncHandler(async (req, res) => {
  // Optimistic lock — concurrent edit protection
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from(table).select("updated_at")
      .eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }
  const updates = sanitize(cols, req.body);
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from(table).update(updates)
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  if (!data) return res.status(404).json({ error: "রেকর্ড পাওয়া যায়নি" });

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "accounts",
    recordId: req.params.id, description: `${label} আপডেট: ৳${data.amount || 0}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);
  res.json(data);
});

const deleteHandler = (table, label) => asyncHandler(async (req, res) => {
  // Capture amount for activity log before delete
  const { data: existing } = await supabase.from(table).select("amount, category")
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!existing) return res.status(404).json({ error: "রেকর্ড পাওয়া যায়নি" });

  const { error } = await supabase.from(table).delete()
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "accounts",
    recordId: req.params.id, description: `${label} মুছে ফেলা: ৳${existing.amount || 0}${existing.category ? ` — ${existing.category}` : ""}`, ip: req.ip }).catch(() => {});
  cache.invalidate(req.user.agency_id);
  res.json({ success: true });
});

// /income and /payments are both views over the `payments` table — both get identical handlers
router.patch("/income/:id",   checkPermission("accounts", "write"),  patchHandler("payments", PAYMENT_PATCH_COLS, "আয়"));
router.delete("/income/:id",  checkPermission("accounts", "delete"), deleteHandler("payments", "আয়"));
router.patch("/payments/:id", checkPermission("accounts", "write"),  patchHandler("payments", PAYMENT_PATCH_COLS, "পেমেন্ট"));
router.delete("/payments/:id",checkPermission("accounts", "delete"), deleteHandler("payments", "পেমেন্ট"));
router.patch("/expenses/:id", checkPermission("accounts", "write"),  patchHandler("expenses", EXPENSE_PATCH_COLS, "খরচ"));
router.delete("/expenses/:id",checkPermission("accounts", "delete"), deleteHandler("expenses", "খরচ"));

module.exports = router;
