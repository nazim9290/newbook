const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { encrypt, decrypt } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");
const { getBranchFilter } = require("../lib/branchFilter");
const cache = require("../lib/cache");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

// GET /api/documents?student_id=xxx&page=1&limit=50
router.get("/", checkPermission("documents", "read"), asyncHandler(async (req, res) => {
  const { student_id, status } = req.query;

  // পেজিনেশন প্যারামিটার — ডিফল্ট page=1, limit=50, সর্বোচ্চ ৫০০
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  // Branch filter — staff শুধু নিজ branch-এর students-এর documents দেখবে
  const branchFilter = getBranchFilter(req.user);
  let branchStudentIds = null;
  if (branchFilter) {
    const { data: branchStudents } = await supabase.from("students")
      .select("id")
      .eq("agency_id", req.user.agency_id)
      .eq("branch", branchFilter);
    branchStudentIds = (branchStudents || []).map(s => s.id);
    if (branchStudentIds.length === 0) return res.json({ data: [], total: 0, page, limit });
  }

  // মোট রেকর্ড সংখ্যা বের করতে count query
  let countQuery = supabase.from("documents").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
  if (student_id) countQuery = countQuery.eq("student_id", student_id);
  if (status && status !== "All") countQuery = countQuery.eq("status", status);
  if (branchStudentIds) countQuery = countQuery.in("student_id", branchStudentIds);
  countQuery = countQuery.limit(0); // শুধু count দরকার, data না
  const { count: total, error: countError } = await countQuery;
  if (countError) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেটেড ডেটা query
  let query = supabase.from("documents").select("*, students(name_en)").eq("agency_id", req.user.agency_id).order("updated_at", { ascending: false }).range(offset, offset + limit - 1);
  if (student_id) query = query.eq("student_id", student_id);
  if (status && status !== "All") query = query.eq("status", status);
  if (branchStudentIds) query = query.in("student_id", branchStudentIds);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // পেজিনেশন সহ response
  res.json({ data, total: total || 0, page, limit });
}));

// POST /api/documents
router.post("/", checkPermission("documents", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("documents").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Cache invalidate — নতুন ডকুমেন্ট তৈরি হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.status(201).json(data);
}));

// PATCH /api/documents/:id
router.patch("/:id", checkPermission("documents", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("documents")
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Cache invalidate — ডকুমেন্ট আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// GET /api/documents/:id/fields — get document extracted fields for cross-validation
router.get("/:id/fields", checkPermission("documents", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("document_fields")
    .select("*")
    .eq("document_id", req.params.id);
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  // Decrypt sensitive field values
  const decrypted = (data || []).map((f) => ({
    ...f,
    field_value: SENSITIVE_DOC_FIELDS.includes(f.field_name) ? decrypt(f.field_value) : f.field_value,
  }));
  res.json(decrypted);
}));

// Sensitive document field names that get encrypted
const SENSITIVE_DOC_FIELDS = ["nid", "passport_number", "father_en", "mother_en", "permanent_address", "bank_account", "account_number"];

// POST /api/documents/:id/fields — save extracted fields
router.post("/:id/fields", checkPermission("documents", "write"), asyncHandler(async (req, res) => {
  const { fields } = req.body; // [{ field_name, field_value }]
  const rows = fields.map((f) => ({
    document_id: req.params.id,
    field_name: f.field_name,
    field_value: SENSITIVE_DOC_FIELDS.includes(f.field_name) ? encrypt(f.field_value) : f.field_value,
  }));

  // upsert on (document_id, field_name)
  const { data, error } = await supabase
    .from("document_fields")
    .upsert(rows, { onConflict: "document_id,field_name" })
    .select();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Cache invalidate — ডকুমেন্ট fields আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// GET /api/documents/cross-validate/:studentId — compare fields across docs
router.get("/cross-validate/:studentId", checkPermission("documents", "read"), asyncHandler(async (req, res) => {
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, doc_type, document_fields(field_name, field_value)")
    .eq("agency_id", req.user.agency_id)
    .eq("student_id", req.params.studentId);

  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // Compare common fields across documents
  const fieldMap = {};
  for (const doc of docs) {
    for (const f of doc.document_fields || []) {
      if (!fieldMap[f.field_name]) fieldMap[f.field_name] = [];
      fieldMap[f.field_name].push({ doc_type: doc.doc_type, doc_id: doc.id, value: f.field_value });
    }
  }

  const mismatches = [];
  for (const [field, entries] of Object.entries(fieldMap)) {
    if (entries.length < 2) continue;
    const values = [...new Set(entries.map((e) => e.value))];
    if (values.length > 1) {
      mismatches.push({ field, entries });
    }
  }

  res.json({ mismatches, total_docs: docs.length });
}));

module.exports = router;
