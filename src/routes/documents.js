const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../lib/db");
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

// DELETE /api/documents/:id — agency_id চেক সহ; uploaded file disk থেকেও মুছে
router.delete("/:id", checkPermission("documents", "delete"), asyncHandler(async (req, res) => {
  // Lookup first — get file_url for disk cleanup + label for activity log
  const { data: existing } = await supabase.from("documents")
    .select("id, label, doc_type, file_url, student_id")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (!existing) return res.status(404).json({ error: "ডকুমেন্ট পাওয়া যায়নি" });

  // Delete the row — document_fields cascade automatically (FK ON DELETE CASCADE)
  const { error } = await supabase.from("documents")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Best-effort: remove the local upload file from disk (skip remote URLs / Drive links)
  if (existing.file_url && existing.file_url.startsWith("/uploads/")) {
    const filePath = path.join(__dirname, "../..", existing.file_url);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
    catch (e) { console.error("[FILE DELETE]", e.message); /* file cleanup failure ≠ user-facing failure */ }
  }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "delete", module: "documents",
    recordId: req.params.id,
    description: `ডকুমেন্ট মুছে ফেলা: ${existing.label || existing.doc_type || req.params.id}`,
    ip: req.ip,
  }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

// GET /api/documents/:id/fields — get document extracted fields for cross-validation
router.get("/:id/fields", checkPermission("documents", "read"), asyncHandler(async (req, res) => {
  // agency ownership verify — document এই agency-র কিনা
  const { data: doc } = await supabase.from("documents").select("id").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!doc) return res.status(403).json({ error: "এই ডকুমেন্ট আপনার এজেন্সির নয়" });

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
  // agency ownership verify
  const { data: doc } = await supabase.from("documents").select("id").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (!doc) return res.status(403).json({ error: "এই ডকুমেন্ট আপনার এজেন্সির নয়" });

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

  // DOB format — Date object / ISO string → "YYYY-MM-DD"
  // pg driver DATE column-কে Date object return করে, তাই instanceof check জরুরি
  const formatDate = (d) => {
    if (!d) return "";
    if (d instanceof Date) return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    const s = String(d);
    // ISO pattern থাকলে সেটা তুলে নাও
    const iso = s.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    // Last resort — Date parse করে দেখো
    const parsed = new Date(d);
    if (isNaN(parsed.getTime()) || parsed.getFullYear() < 1900) return "";
    return parsed.toISOString().slice(0, 10);
  };

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

  // ── document_data table থেকেও check (DocType system storage) — doc_type name + category সহ ──
  const { data: docdata } = await supabase
    .from("document_data")
    .select("doc_type_id, field_data, doc_types(name, category)")
    .eq("student_id", req.params.studentId)
    .eq("agency_id", req.user.agency_id);
  // doc_type name + category resolve
  (docdata || []).forEach(dd => {
    dd.doc_type_name = dd.doc_types?.name || dd.doc_type_id;
    dd.doc_type_category = dd.doc_types?.category || "personal";
  });

  // ── Sponsor data fetch — sponsor-related docs (TIN/Income Tax/Annual Income)-এর জন্য ──
  const { data: sponsorRow } = await supabase
    .from("sponsors")
    .select("*")
    .eq("student_id", req.params.studentId)
    .single();
  const sponsor = sponsorRow ? decryptSensitiveFields(sponsorRow) : null;

  // Sponsor fields normalize — frontend display + comparison-এর জন্য
  const sponsorData = sponsor ? {
    name_en: sponsor.name_en || sponsor.name || "",
    father_name: sponsor.father_name || "",
    mother_name: sponsor.mother_name || "",
    present_address: sponsor.present_address || sponsor.address || "",
    permanent_address: sponsor.permanent_address || sponsor.address || "",
    tin: sponsor.tin || "",
    nid: sponsor.nid || "",
    dob: sponsor.dob ? formatDate(sponsor.dob) : "",
    company_name: sponsor.company_name || "",
    company_address: sponsor.company_address || "",
    trade_license: sponsor.trade_license_no || sponsor.trade_license || "",
    // 3-row repeatable: year-wise income/tax records
    rows: [1, 2, 3].map(n => ({
      year: sponsor[`income_year_${n}`] || "",
      source: sponsor[`income_source_${n}`] || "",
      income: sponsor[`annual_income_y${n}`] || "",
      tax: sponsor[`tax_y${n}`] || "",
    })).filter(r => r.year || r.income || r.tax),
  } : null;

  // Sponsor banks — Bank Statement comparison-এর জন্য (multi-row)
  let sponsorBanks = [];
  if (sponsor?.id) {
    const { data: banks } = await supabase.from("sponsor_banks").select("*").eq("sponsor_id", sponsor.id);
    sponsorBanks = (banks || []).map(b => decryptSensitiveFields(b));
  }

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

    // docdata table থেকেও check — sponsor-category docs বাদ (সেগুলো sponsor profile-এর সাথে compare হবে)
    for (const dd of (docdata || [])) {
      if (dd.doc_type_category === "sponsor") continue;
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

  // ── Step 4: Sponsor profile vs Sponsor-category documents ──
  // Sponsor docs শনাক্ত: doc_types.category === "sponsor"
  // Currently covered: TIN, Income Tax, Annual Income, Sponsor NID, Trade License, Bank Statement
  // Repeatable rows (tax_payments / income_records) match হয় Year-এর ভিত্তিতে
  const SPONSOR_COMPARE_FIELDS = [
    { profileKey: "name_en", docKeys: ["name_en", "name", "full_name", "owner_name", "account_holder_name"], label: "Sponsor Name" },
    { profileKey: "father_name", docKeys: ["father_name", "fathers_name", "father", "father_husband_name"], label: "Father's Name" },
    { profileKey: "mother_name", docKeys: ["mother_name", "mothers_name", "mother"], label: "Mother's Name" },
    { profileKey: "present_address", docKeys: ["present_address", "current_address"], label: "Present Address" },
    { profileKey: "permanent_address", docKeys: ["permanent_address", "address"], label: "Permanent Address" },
    { profileKey: "tin", docKeys: ["tin_number", "etin", "tin", "e_tin"], label: "TIN / e-TIN" },
    { profileKey: "nid", docKeys: ["nid_number", "nid", "national_id", "nid_passport"], label: "NID" },
    { profileKey: "dob", docKeys: ["dob", "date_of_birth", "birth_date"], label: "Date of Birth" },
    { profileKey: "company_name", docKeys: ["business_name", "company_name"], label: "Business / Company Name" },
    { profileKey: "company_address", docKeys: ["business_address", "company_address"], label: "Business Address" },
    { profileKey: "trade_license", docKeys: ["license_no", "trade_license", "trade_license_no"], label: "Trade License No" },
  ];

  const sponsorMismatches = [];
  const sponsorMatches = [];

  if (sponsorData) {
    const sponsorDocs = (docdata || []).filter(dd => dd.doc_type_category === "sponsor");

    // ── Scalar fields compare (name, father, mother, addresses, TIN) ──
    for (const cf of SPONSOR_COMPARE_FIELDS) {
      const profileValue = (sponsorData[cf.profileKey] || "").toString().trim().toLowerCase();
      if (!profileValue) continue;
      // TIN match — ignore "/", "-", spaces — "339989116751/C-022" vs "339989116751" both ok
      const normalizeTin = (v) => cf.profileKey === "tin"
        ? String(v).toLowerCase().replace(/[\s\-/]/g, "").replace(/c$/, "")
        : String(v).trim().toLowerCase();

      for (const dd of sponsorDocs) {
        const fd = dd.field_data || {};
        for (const dk of cf.docKeys) {
          const rawDoc = fd[dk];
          if (rawDoc === undefined || rawDoc === null || rawDoc === "") continue;
          const docNorm = normalizeTin(rawDoc);
          const profNorm = normalizeTin(sponsorData[cf.profileKey]);
          // TIN special: doc-side often has full "339989116751/C-022", profile may have just digits — substring match
          const isTinMatch = cf.profileKey === "tin" && (docNorm.includes(profNorm) || profNorm.includes(docNorm));
          if (docNorm !== profNorm && !isTinMatch) {
            sponsorMismatches.push({
              field: cf.label,
              profile_value: sponsorData[cf.profileKey],
              doc_type: dd.doc_type_name || "Document",
              doc_value: rawDoc,
            });
          } else {
            sponsorMatches.push({ field: cf.label, doc_type: dd.doc_type_name });
          }
        }
      }
    }

    // ── Repeatable rows compare — year-wise tax/income records ──
    // Income Tax cert: tax_payments [{Year, Amount}]
    // Annual Income cert: income_records [{Year, Source, Amount}]
    for (const dd of sponsorDocs) {
      const fd = dd.field_data || {};
      const docName = (dd.doc_type_name || "").toLowerCase();
      const isIncomeTax = docName.includes("income tax");
      const isAnnualIncome = docName.includes("annual income");
      if (!isIncomeTax && !isAnnualIncome) continue;

      const docRows = Array.isArray(fd._members) ? fd._members : [];
      if (docRows.length === 0) continue;

      // প্রতিটি sponsor row-এর জন্য — Year দিয়ে match করো document row-এ
      for (const sr of sponsorData.rows) {
        if (!sr.year) continue;
        const matchRow = docRows.find(dr => String(dr.Year || "").trim() === String(sr.year).trim());
        if (!matchRow) {
          // sponsor profile-এ year আছে কিন্তু document-এ নেই
          sponsorMismatches.push({
            field: `${sr.year} → ${isIncomeTax ? "Tax row" : "Income row"} missing in document`,
            profile_value: isIncomeTax ? `Tax: ${sr.tax}` : `Income: ${sr.income}`,
            doc_type: dd.doc_type_name,
            doc_value: "—",
          });
          continue;
        }

        if (isIncomeTax) {
          const profileTax = String(sr.tax || "").replace(/[,\s]/g, "");
          const docTax = String(matchRow.Amount || "").replace(/[,\s]/g, "");
          if (profileTax && docTax && profileTax !== docTax) {
            sponsorMismatches.push({
              field: `${sr.year} → Tax Paid`,
              profile_value: sr.tax,
              doc_type: dd.doc_type_name,
              doc_value: matchRow.Amount,
            });
          } else if (profileTax && docTax) {
            sponsorMatches.push({ field: `${sr.year} Tax`, doc_type: dd.doc_type_name });
          }
        }

        if (isAnnualIncome) {
          const profileInc = String(sr.income || "").replace(/[,\s]/g, "");
          const docInc = String(matchRow.Amount || "").replace(/[,\s]/g, "");
          if (profileInc && docInc && profileInc !== docInc) {
            sponsorMismatches.push({
              field: `${sr.year} → Annual Income`,
              profile_value: sr.income,
              doc_type: dd.doc_type_name,
              doc_value: matchRow.Amount,
            });
          } else if (profileInc && docInc) {
            sponsorMatches.push({ field: `${sr.year} Income`, doc_type: dd.doc_type_name });
          }
          // Source compare (case-insensitive partial: "Business" vs "Business Income")
          if (sr.source && matchRow.Source) {
            const ps = String(sr.source).toLowerCase();
            const ds = String(matchRow.Source).toLowerCase();
            if (!ps.includes(ds) && !ds.includes(ps)) {
              sponsorMismatches.push({
                field: `${sr.year} → Income Source`,
                profile_value: sr.source,
                doc_type: dd.doc_type_name,
                doc_value: matchRow.Source,
              });
            }
          }
        }
      }
    }

    // ── Bank Statement docs vs sponsor_banks rows (multi-row, match by account_no) ──
    const bankDocs = sponsorDocs.filter(dd => /bank statement/i.test(dd.doc_type_name || ""));
    for (const dd of bankDocs) {
      const fd = dd.field_data || {};
      const docAcct = String(fd.account_no || "").replace(/[\s\-]/g, "");
      const docBank = String(fd.bank_name || "").trim().toLowerCase();
      if (!docAcct && !docBank) continue;

      // Match: account_no first, fallback bank_name
      const matched = sponsorBanks.find(b => {
        const profAcct = String(b.account_no || "").replace(/[\s\-]/g, "");
        if (docAcct && profAcct && profAcct === docAcct) return true;
        if (docBank && b.bank_name && String(b.bank_name).trim().toLowerCase() === docBank) return true;
        return false;
      });

      if (!matched) {
        sponsorMismatches.push({
          field: "Bank Account not in profile",
          profile_value: sponsorBanks.length === 0 ? "(no banks saved)" : `${sponsorBanks.length} bank(s) saved`,
          doc_type: dd.doc_type_name,
          doc_value: `${fd.bank_name || ""} ${fd.account_no || ""}`.trim() || "(unknown)",
        });
        continue;
      }

      // Per-field compare: bank_name, branch, balance, balance_date
      const bankFields = [
        { key: "bank_name", label: "Bank Name", profile: matched.bank_name, doc: fd.bank_name },
        { key: "branch", label: "Branch", profile: matched.branch, doc: fd.branch },
        { key: "balance", label: "Balance", profile: matched.balance, doc: fd.balance, numeric: true },
        { key: "balance_date", label: "Balance Date", profile: matched.balance_date ? formatDate(matched.balance_date) : "", doc: fd.balance_date },
      ];
      for (const bf of bankFields) {
        const p = bf.numeric
          ? String(bf.profile || "").replace(/[,\s]/g, "")
          : String(bf.profile || "").trim().toLowerCase();
        const d = bf.numeric
          ? String(bf.doc || "").replace(/[,\s]/g, "")
          : String(bf.doc || "").trim().toLowerCase();
        if (!p || !d) continue;
        if (p !== d) {
          sponsorMismatches.push({
            field: `${matched.bank_name || "Bank"} → ${bf.label}`,
            profile_value: bf.profile,
            doc_type: dd.doc_type_name,
            doc_value: bf.doc,
          });
        } else {
          sponsorMatches.push({ field: `Bank ${bf.label}`, doc_type: dd.doc_type_name });
        }
      }
    }
  }

  res.json({
    mismatches,
    matches_count: matches.length,
    total_docs: (docs || []).length + (docdata || []).length,
    profile: profileData,
    sponsor_mismatches: sponsorMismatches,
    sponsor_matches_count: sponsorMatches.length,
    sponsor: sponsorData,
  });
}));

module.exports = router;
