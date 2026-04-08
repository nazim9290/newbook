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

  // Cursor-based pagination
  const { applyCursor, buildResponse } = require("../lib/cursorPagination");
  let query = supabase.from("documents").select("*, students(name_en)").eq("agency_id", req.user.agency_id);
  if (student_id) query = query.eq("student_id", student_id);
  if (status && status !== "All") query = query.eq("status", status);
  if (branchStudentIds) query = query.in("student_id", branchStudentIds);
  query = applyCursor(query, req.query, { sortCol: "updated_at", ascending: false });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  res.json(buildResponse(data || [], req.query, { sortCol: "updated_at", total: total || 0 }));
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

// GET /api/documents/cross-validate/:studentId — Student Profile vs Documents compare
// Source of Truth: Student Profile-এর data (এজেন্সি ইনপুট) — documents-এর data সেটার সাথে মিলাবে
router.get("/cross-validate/:studentId", checkPermission("documents", "read"), asyncHandler(async (req, res) => {
  // ── Step 1: Student Profile data আনো (source of truth) ──
  const { data: student } = await supabase
    .from("students")
    .select("name_en, father_name, father_name_en, mother_name, mother_name_en, dob, permanent_address, current_address, phone, passport_number, nid, gender")
    .eq("id", req.params.studentId)
    .eq("agency_id", req.user.agency_id)
    .single();

  if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  // Encrypted fields decrypt করো
  const { decryptSensitiveFields } = require("../lib/crypto");
  const dec = decryptSensitiveFields(student);

  // DOB format — ISO → YYYY-MM-DD
  const formatDate = (d) => { if (!d) return ""; const s = String(d); return s.length > 10 ? s.slice(0, 10) : s; };

  // Student Profile → field map (decrypt ও normalize করে)
  const profileData = {
    name_en: dec.name_en || "",
    father_name: dec.father_name_en || dec.father_name || "",
    mother_name: dec.mother_name_en || dec.mother_name || "",
    dob: formatDate(dec.dob),
    permanent_address: dec.permanent_address || "",
    current_address: dec.current_address || "",
    phone: dec.phone || "",
    passport_number: dec.passport_number || "",
    nid: dec.nid || "",
    gender: dec.gender || "",
  };

  // ── Step 2: সব document-এর field data আনো ──
  // documents table — extracted_data (OCR থেকে) + document_fields (manual input)
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, doc_type, extracted_data")
    .eq("agency_id", req.user.agency_id)
    .eq("student_id", req.params.studentId);

  if (error) { console.error("[Cross-Validate] documents query:", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // document_fields table — আলাদা query (FK hint সমস্যা এড়াতে)
  let docFields = [];
  if (docs && docs.length > 0) {
    const docIds = docs.map(d => d.id);
    const { data: fields } = await supabase
      .from("document_fields")
      .select("document_id, field_name, field_value")
      .in("document_id", docIds);
    docFields = fields || [];
  }
  // প্রতি document-এ fields attach
  (docs || []).forEach(doc => {
    doc.fields = docFields.filter(f => f.document_id === doc.id);
  });

  // ── document_data table থেকেও check (DocType system storage) — doc_type name সহ ──
  const { data: docdata } = await supabase
    .from("document_data")
    .select("doc_type_id, field_data, doc_types(name)")
    .eq("student_id", req.params.studentId)
    .eq("agency_id", req.user.agency_id);
  // doc_type name resolve
  (docdata || []).forEach(dd => {
    dd.doc_type_name = dd.doc_types?.name || dd.doc_type_id;
  });

  // ── Step 3: Compare — Profile data vs Document data ──
  // তুলনাযোগ্য fields — student profile key → document field key variations
  const COMPARE_FIELDS = [
    { profileKey: "name_en", docKeys: ["name_en", "full_name", "name", "applicant_name"], label: "Name (EN)" },
    { profileKey: "father_name", docKeys: ["father_name", "father_en", "fathers_name", "father"], label: "Father's Name" },
    { profileKey: "mother_name", docKeys: ["mother_name", "mother_en", "mothers_name", "mother"], label: "Mother's Name" },
    { profileKey: "dob", docKeys: ["dob", "date_of_birth", "birth_date"], label: "Date of Birth" },
    { profileKey: "permanent_address", docKeys: ["permanent_address", "address", "present_address"], label: "Permanent Address" },
    { profileKey: "current_address", docKeys: ["current_address", "present_address"], label: "Current Address" },
    { profileKey: "passport_number", docKeys: ["passport_number", "passport_no", "passport"], label: "Passport Number" },
    { profileKey: "nid", docKeys: ["nid", "nid_number", "national_id"], label: "NID" },
    { profileKey: "gender", docKeys: ["gender", "sex"], label: "Gender" },
  ];

  const mismatches = [];
  const matches = [];

  for (const cf of COMPARE_FIELDS) {
    const profileValue = (profileData[cf.profileKey] || "").toString().trim().toLowerCase();
    if (!profileValue) continue; // profile-এ data নেই — compare করার দরকার নেই

    // document_fields + extracted_data থেকে match খোঁজা
    for (const doc of (docs || [])) {
      // document_fields table থেকে
      for (const f of (doc.fields || [])) {
        const fName = (f.field_name || "").toLowerCase();
        if (!cf.docKeys.includes(fName)) continue;
        const docValue = (f.field_value || "").toString().trim().toLowerCase();
        if (!docValue) continue;
        if (docValue !== profileValue) {
          mismatches.push({ field: cf.label, profile_value: profileData[cf.profileKey], doc_type: doc.doc_type || "Unknown", doc_value: f.field_value });
        } else {
          matches.push({ field: cf.label, doc_type: doc.doc_type });
        }
      }
      // extracted_data (OCR) থেকেও check
      const ed = doc.extracted_data || {};
      for (const dk of cf.docKeys) {
        const docValue = (ed[dk] || "").toString().trim().toLowerCase();
        if (!docValue) continue;
        if (docValue !== profileValue) {
          mismatches.push({ field: cf.label, profile_value: profileData[cf.profileKey], doc_type: doc.doc_type || "Unknown", doc_value: ed[dk] });
        } else {
          matches.push({ field: cf.label, doc_type: doc.doc_type });
        }
      }
    }

    // docdata table থেকেও check
    for (const dd of (docdata || [])) {
      const fd = dd.field_data || {};
      for (const dk of cf.docKeys) {
        const docValue = (fd[dk] || "").toString().trim().toLowerCase();
        if (!docValue) continue;
        if (docValue !== profileValue) {
          mismatches.push({
            field: cf.label,
            profile_value: profileData[cf.profileKey],
            doc_type: dd.doc_type_name || "Document",
            doc_value: fd[dk],
          });
        } else {
          matches.push({ field: cf.label, doc_type: dd.doc_type_name });
        }
      }
    }
  }

  res.json({
    mismatches,
    matches_count: matches.length,
    total_docs: (docs || []).length + (docdata || []).length,
    profile: profileData,
  });
}));

module.exports = router;
