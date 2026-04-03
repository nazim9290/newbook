const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const bcrypt = require("bcryptjs");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const { generateId } = require("../lib/idGenerator");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// GET /api/students — list with search + filters
router.get("/", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { search, status, country, batch, school, branch, page = 1, limit: rawLimit = 50 } = req.query;
  const limit = Math.min(Math.max(parseInt(rawLimit) || 50, 1), 100); // সর্বোচ্চ ১০০
  const safePage = Math.max(parseInt(page) || 1, 1);
  const offset = (safePage - 1) * limit;

  // batch ও school এর নাম সহ fetch করো (join)
  let query = supabase.from("students").select("*, batches(name), schools(name_en)", { count: "exact" }).eq("agency_id", req.user.agency_id);

  if (search) {
    query = query.or(`name_en.ilike.%${search}%,phone.ilike.%${search}%,id.ilike.%${search}%`);
  }
  if (status && status !== "All") query = query.eq("status", status);
  if (country && country !== "All") query = query.eq("country", country);
  if (batch && batch !== "All") query = query.eq("batch", batch);
  if (school && school !== "All") query = query.eq("school", school);
  if (branch && branch !== "All") query = query.eq("branch", branch);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // DB fields → frontend field mapping
  const mapped = (data || []).map(s => ({
    ...s,
    batch: s.batches?.name || s.batch || "",      // frontend batch (name) চায়
    school: s.schools?.name_en || s.school || "",  // frontend school (name) চায়
    passport: s.passport_number || "",              // frontend passport চায়
    father: s.father_name || "",
    mother: s.mother_name || "",
    created: s.created_at ? (s.created_at instanceof Date ? s.created_at.toISOString().slice(0, 10) : String(s.created_at).slice(0, 10)) : "",
  }));

  res.json({ data: decryptMany(mapped), total: count, page: +page, limit: +limit });
}));

// GET /api/students/:id — single student with related data
router.get("/:id", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  // Main student record
  const { data: student, error } = await supabase
    .from("students").select("*").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();

  if (error) return res.status(404).json({ error: "স্টুডেন্ট পাওয়া যায়নি" });

  // Related data — আলাদা query (JOIN error এড়ানোর জন্য)
  const sid = req.params.id;
  const [eduRes, examRes, famRes, sponsorRes, payRes, docRes, workRes, jpStudyRes] = await Promise.all([
    supabase.from("student_education").select("*").eq("student_id", sid),
    supabase.from("student_jp_exams").select("*").eq("student_id", sid),
    supabase.from("student_family").select("*").eq("student_id", sid),
    supabase.from("sponsors").select("*").eq("student_id", sid).single(),
    supabase.from("payments").select("*").eq("student_id", sid).order("date", { ascending: false }),
    supabase.from("documents").select("*").eq("student_id", sid),
    // 職歴 (Work Experience) — Resume fields
    supabase.from("student_work_experience").select("*").eq("student_id", sid),
    // 日本語学習歴 (JP Study History) — Resume fields
    supabase.from("student_jp_study").select("*").eq("student_id", sid),
  ]);

  const decrypted = decryptSensitiveFields(student);
  decrypted.student_education = eduRes.data || [];
  decrypted.student_jp_exams = examRes.data || [];
  decrypted.student_family = famRes.data || [];
  decrypted.sponsors = sponsorRes.data ? [decryptSensitiveFields(sponsorRes.data)] : [];
  decrypted.sponsor = sponsorRes.data ? decryptSensitiveFields(sponsorRes.data) : null;
  decrypted.payments = payRes.data || [];
  decrypted.documents = docRes.data || [];
  // Resume related tables — 職歴, 日本語学習歴
  decrypted.work_experience = workRes.data || [];
  decrypted.jp_study = jpStudyRes.data || [];

  res.json(decrypted);
}));

// POST /api/students — নতুন student তৈরি
// students table-এ শুধু valid columns পাঠাও, বাকি সব ignore
const STUDENT_COLUMNS = [
  "id", "name_en", "name_bn", "name_katakana", "phone", "whatsapp", "email",
  "dob", "gender", "marital_status", "nationality", "blood_group", "nid",
  "passport_number", "passport_issue", "passport_expiry",
  "permanent_address", "current_address", "father_name", "father_name_en",
  "mother_name", "mother_name_en", "status", "country", "school_id", "batch_id",
  "intake", "visa_type", "source", "agent_id", "referral_info", "student_type",
  "counselor", "branch", "gdrive_folder_url", "photo_url", "internal_notes",
  // Resume fields — Excel入学願書 support
  "birth_place", "occupation", "reason_for_study", "future_plan", "study_subject",
  // Passport page fields — emergency contact, spouse
  "spouse_name", "emergency_contact", "emergency_phone",
];

router.post("/", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const body = req.body;
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

  // ── Agency prefix দিয়ে Student ID auto-generate ──
  const studentId = body.id || await generateId(agencyId, "student");

  // শুধু valid DB columns রাখো, বাকি সব ফেলে দাও
  const record = { id: studentId, agency_id: agencyId };
  for (const col of STUDENT_COLUMNS) {
    if (col === "id") continue; // id উপরে set হয়েছে
    if (body[col] !== undefined && body[col] !== "") record[col] = body[col];
  }

  // Frontend field → DB column mapping
  if (!record.passport_number && body.passport) record.passport_number = body.passport;
  if (!record.father_name && body.father) record.father_name = body.father;
  if (!record.mother_name && body.mother) record.mother_name = body.mother;

  const encrypted = encryptSensitiveFields(record);

  const { data, error } = await supabase
    .from("students")
    .insert(encrypted)
    .select()
    .single();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // Activity log — student তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "students",
    recordId: data.id, description: `নতুন স্টুডেন্ট: ${data.name_en}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — dashboard ও reports refresh হবে
  cache.invalidate(agencyId);

  res.status(201).json(decryptSensitiveFields(data));
}));

// PATCH /api/students/:id — student update
router.patch("/:id", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const body = req.body;

  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("students").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // শুধু valid DB columns রাখো
  const updates = {};
  for (const col of STUDENT_COLUMNS) {
    if (body[col] !== undefined) updates[col] = body[col];
  }
  if (body.passport) updates.passport_number = body.passport;
  if (body.father) updates.father_name = body.father;
  if (body.mother) updates.mother_name = body.mother;

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  updates.updated_at = new Date().toISOString();

  const encrypted = encryptSensitiveFields(updates);

  const { data, error } = await supabase
    .from("students")
    .update(encrypted)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // ── Sponsor upsert — frontend sponsor object থাকলে sponsors table-এ save ──
  if (body.sponsor && typeof body.sponsor === "object") {
    try {
      const sp = body.sponsor;
      // sponsors table-এর valid columns — বাকি সব ignore
      const SPONSOR_COLS = [
        "name", "name_en", "relationship", "phone", "address", "nid",
        "company_name", "company_address", "company_phone", "trade_license", "tin",
        "annual_income_y1", "annual_income_y2", "annual_income_y3",
        "tax_y1", "tax_y2", "tax_y3",
        "tuition_jpy", "living_jpy_monthly", "payment_method", "exchange_rate",
        "fund_formation", "notes",
        // 経費支弁書 fields
        "statement", "payment_to_student", "payment_to_school", "sign_date",
        // Resume fields — 入学願書 support
        "dob",
      ];
      const sponsorRecord = { student_id: req.params.id };
      for (const col of SPONSOR_COLS) {
        if (sp[col] !== undefined) {
          // Numeric columns — empty string কে null করো
          if (["annual_income_y1","annual_income_y2","annual_income_y3","tax_y1","tax_y2","tax_y3","tuition_jpy","living_jpy_monthly","exchange_rate"].includes(col)) {
            sponsorRecord[col] = sp[col] === "" ? null : Number(sp[col]);
          } else if (col === "fund_formation") {
            sponsorRecord[col] = typeof sp[col] === "string" ? sp[col] : JSON.stringify(sp[col] || []);
          } else if (["payment_to_student", "payment_to_school"].includes(col)) {
            sponsorRecord[col] = !!sp[col];
          } else if (col === "sign_date") {
            sponsorRecord[col] = sp[col] || null;
          } else {
            sponsorRecord[col] = sp[col];
          }
        }
      }
      sponsorRecord.updated_at = new Date().toISOString();

      // Upsert — student_id UNIQUE constraint দিয়ে conflict resolve
      const encSponsor = encryptSensitiveFields(sponsorRecord);
      await supabase.from("sponsors").upsert(encSponsor, { onConflict: "student_id" });
    } catch (spErr) {
      console.error("[Sponsor Upsert]", spErr.message);
      // Sponsor save fail হলেও student update সফল — পরে retry করা যাবে
    }
  }

  // ── Billing: student ENROLLED হলে charge তৈরি ──
  if (body.status === "ENROLLED" && data) {
    try {
      const agencyId = data.agency_id || req.user?.agency_id;
      if (agencyId) {
        // Agency-র per_student_fee নাও
        const { data: agency } = await supabase.from("agencies").select("per_student_fee, trial_ends_at, settings").eq("id", agencyId).single();
        const isDedicated = agency?.settings?.dedicated;
        const trialActive = agency?.trial_ends_at && new Date(agency.trial_ends_at) > new Date();

        // Dedicated না হলে এবং trial শেষ হলে billing record তৈরি
        if (!isDedicated && !trialActive && agency?.per_student_fee > 0) {
          await supabase.from("billing_records").insert({
            agency_id: agencyId, student_id: data.id,
            event: "student_enrolled", amount: agency.per_student_fee, status: "pending",
          });
          // Agency total billed update
          await supabase.from("agencies").update({
            total_billed: (agency.total_billed || 0) + agency.per_student_fee
          }).eq("id", agencyId);
        }
      }
    } catch (billingErr) {
      console.error("[Billing] Error:", billingErr.message);
      // Billing error হলেও student update সফল — billing পরে ঠিক করা যাবে
    }
  }

  // Activity log — student আপডেট (status change সহ)
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "students",
    recordId: req.params.id, description: `স্টুডেন্ট আপডেট: ${data.name_en || req.params.id}${body.status ? ` → ${body.status}` : ""}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — student update-এ dashboard/reports পুরনো হয়ে যায়
  cache.invalidate(req.user.agency_id);

  res.json(decryptSensitiveFields(data));
}));

// DELETE /api/students/:id
router.delete("/:id", checkPermission("students", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("students").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "students",
    recordId: req.params.id, description: `স্টুডেন্ট মুছে ফেলা: ${req.params.id}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — student delete হলে counts বদলায়
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

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

// POST /api/students/:id/exam-result — JLPT/NAT পরীক্ষার ফলাফল save
router.post("/:id/exam-result", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { exam_type, level, score, result, exam_date } = req.body;
  if (!exam_type) return res.status(400).json({ error: "পরীক্ষার ধরন দিন" });
  const { data, error } = await supabase.from("student_jp_exams").insert({
    student_id: req.params.id,
    agency_id: req.user.agency_id,
    exam_type, level, score: score || null, result: result || null,
    exam_date: exam_date || null,
  }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// ── Education CRUD — শিক্ষাগত তথ্য (+ entrance_year, address, school_type for Resume) ──
router.post("/:id/education", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { level, school_name, year, board, gpa, group_name, entrance_year, address, school_type } = req.body;
  const { data, error } = await supabase.from("student_education").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    level, school_name, passing_year: year, board, gpa, group_name,
    entrance_year: entrance_year || "", address: address || "", school_type: school_type || "",
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.patch("/:id/education/:eduId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { level, school_name, year, board, gpa, group_name, entrance_year, address, school_type } = req.body;
  const { data, error } = await supabase.from("student_education").update({
    level, school_name, passing_year: year, board, gpa, group_name,
    entrance_year: entrance_year || "", address: address || "", school_type: school_type || "",
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.eduId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

router.delete("/:id/education/:eduId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_education").delete().eq("id", req.params.eduId);
  res.json({ success: true });
}));

// PATCH /api/students/:id/jp-exams/:examId — পরীক্ষার ফলাফল আপডেট
router.patch("/:id/jp-exams/:examId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { exam_type, level, score, result, exam_date } = req.body;
  const { data, error } = await supabase.from("student_jp_exams").update({
    exam_type, level, score: score || null, result: result || null,
    exam_date: exam_date || null, updated_at: new Date().toISOString(),
  }).eq("id", req.params.examId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

// DELETE /api/students/:id/jp-exams/:examId — পরীক্ষার ফলাফল মুছুন
router.delete("/:id/jp-exams/:examId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_jp_exams").delete().eq("id", req.params.examId);
  res.json({ success: true });
}));

// ── Work Experience CRUD — 職歴 (Resume support) ──
// POST /api/students/:id/work-experience — নতুন কর্ম অভিজ্ঞতা যোগ
router.post("/:id/work-experience", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { company_name, address, start_date, end_date, position } = req.body;
  const { data, error } = await supabase.from("student_work_experience").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    company_name, address, start_date, end_date, position,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// DELETE /api/students/:id/work-experience/:weId — কর্ম অভিজ্ঞতা মুছুন
router.delete("/:id/work-experience/:weId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_work_experience").delete().eq("id", req.params.weId);
  res.json({ success: true });
}));

// ── JP Study History CRUD — 日本語学習歴 (Resume support) ──
// POST /api/students/:id/jp-study — নতুন জাপানি ভাষা শিক্ষা ইতিহাস যোগ
router.post("/:id/jp-study", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { institution, address, period_from, period_to, total_hours } = req.body;
  const { data, error } = await supabase.from("student_jp_study").insert({
    student_id: req.params.id, agency_id: req.user.agency_id,
    institution, address, period_from, period_to, total_hours,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

// DELETE /api/students/:id/jp-study/:jsId — জাপানি ভাষা শিক্ষা ইতিহাস মুছুন
router.delete("/:id/jp-study/:jsId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  await supabase.from("student_jp_study").delete().eq("id", req.params.jsId);
  res.json({ success: true });
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

// GET /api/students/:id/payments — student এর payments
router.get("/:id/payments-list", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("payments")
    .select("*").eq("student_id", req.params.id).order("date", { ascending: false });
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

// ================================================================
// GET /api/students/import/template — Import template (.xlsx) download
// Phone, NID, WhatsApp column Text format — leading zero রক্ষা
// ================================================================
router.get("/import/template", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Students");

  // Column config — text format columns চিহ্নিত
  const cols = [
    { header: "Name *", key: "name", width: 25 },
    { header: "Name (বাংলা)", key: "name_bn", width: 25 },
    { header: "Phone *", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 22 },
    { header: "Date of Birth", key: "dob", width: 15 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Passport No", key: "passport", width: 15 },
    { header: "NID", key: "nid", width: 20 },
    { header: "Father Name", key: "father", width: 20 },
    { header: "Mother Name", key: "mother", width: 20 },
    { header: "Address", key: "address", width: 30 },
    { header: "Country", key: "country", width: 12 },
    { header: "Branch", key: "branch", width: 12 },
    { header: "Source", key: "source", width: 12 },
    { header: "Blood Group", key: "blood", width: 10 },
    { header: "WhatsApp", key: "whatsapp", width: 18 },
    { header: "Nationality", key: "nationality", width: 12 },
    { header: "Visa Type", key: "visa_type", width: 18 },
  ];
  ws.columns = cols;

  // Header row style — cyan background, white bold text
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF06B6D4" } };
  headerRow.alignment = { horizontal: "center" };

  // Required columns (* চিহ্নিত) red background
  [1, 3].forEach(col => {
    const cell = headerRow.getCell(col);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF43F5E" } };
  });

  // Row 2 = নির্দেশনা (হালকা হলুদ)
  const guideRow = ws.addRow([
    "বাধ্যতামূলক — English-এ পুরো নাম",
    "ঐচ্ছিক — বাংলায় নাম",
    "বাধ্যতামূলক — 01XXXXXXXXX",
    "ঐচ্ছিক",
    "YYYY-MM-DD format",
    "Male / Female / Other",
    "পাসপোর্ট নম্বর",
    "জাতীয় পরিচয়পত্র নম্বর",
    "পিতার নাম",
    "মাতার নাম",
    "স্থায়ী ঠিকানা",
    "Japan / Germany / Korea",
    "Main / Chattogram / Sylhet",
    "Facebook / Walk-in / Agent / Referral",
    "A+ / B+ / O+ / AB+ ইত্যাদি",
    "আলাদা হলে WhatsApp নম্বর",
    "Bangladeshi",
    "Language Student / SSW / TITP",
  ]);
  guideRow.font = { italic: true, size: 9, color: { argb: "FF666666" } };
  guideRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFDE7" } };

  // Row 3 = Sample data
  ws.addRow([
    "Mohammad Rahim", "মোহাম্মদ রহিম", "01811111111", "rahim@gmail.com",
    "1998-03-12", "Male", "BK1234567", "1998123456789",
    "Abdul Karim", "Fatema Begum", "Comilla, Bangladesh",
    "Japan", "Main", "Facebook", "B+", "01811111111", "Bangladeshi", "Language Student",
  ]);

  // Phone, NID, WhatsApp columns → Text format (leading zero রক্ষা)
  const textCols = [3, 8, 16]; // Phone, NID, WhatsApp
  for (let r = 1; r <= 100; r++) {
    textCols.forEach(c => {
      ws.getCell(r, c).numFmt = "@"; // @ = Text format
    });
  }

  // Send as .xlsx
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="AgencyBook_Student_Import_Template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));

// ================================================================
// POST /api/students/import — Excel থেকে bulk student import
// Body: { students: [{ name_en, phone, dob, ... }, ...] }
// Frontend Excel parse করে mapped data পাঠায়
// ================================================================
router.post("/import", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { students: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "কোনো student data পাওয়া যায়নি" });
  }

  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
  const results = { success: 0, failed: 0, errors: [] };

  // প্রতিটি row-কে valid student record-এ convert
  const records = rows.map((row, idx) => {
    const year = new Date().getFullYear();
    const seq = String(idx + 1).padStart(3, "0");
    const record = { agency_id: agencyId, id: row.id || `S-${year}-IMP${seq}` };
    for (const col of STUDENT_COLUMNS) {
      if (col === "id") continue;
      if (row[col] !== undefined && row[col] !== null && row[col] !== "") {
        record[col] = row[col];
      }
    }
    if (!record.passport_number && row.passport) record.passport_number = row.passport;
    if (!record.father_name && row.father) record.father_name = row.father;
    if (!record.mother_name && row.mother) record.mother_name = row.mother;
    if (!record.name_en) record.name_en = row.name || row.full_name || row.student_name || `Student ${idx + 1}`;
    if (!record.status) record.status = "ENROLLED";
    return encryptSensitiveFields(record);
  });

  // Batch insert — Supabase supports bulk insert
  const { data, error } = await supabase
    .from("students")
    .insert(records)
    .select();

  if (error) {
    // Bulk fail → try one by one
    for (let i = 0; i < records.length; i++) {
      const { error: sErr } = await supabase.from("students").insert(records[i]).select();
      if (sErr) {
        results.failed++;
        results.errors.push({ row: i + 1, name: rows[i].name_en || rows[i].name || `Row ${i + 1}`, error: "ডাটা সংরক্ষণ ব্যর্থ" });
      } else {
        results.success++;
      }
    }
  } else {
    results.success = data.length;
  }

  // ক্যাশ invalidate — bulk import এ student count বদলায়
  if (results.success > 0) cache.invalidate(agencyId);

  res.json({
    message: `${results.success} জন import সফল, ${results.failed} জন ব্যর্থ`,
    ...results,
    total: rows.length,
  });
}));

// ================================================================
// POST /api/students/import/parse — Excel file parse করে columns return
// ================================================================
const multer = require("multer");
const ExcelJS = require("exceljs");
const importUpload = multer({ dest: require("path").join(__dirname, "../../uploads"), limits: { fileSize: 10 * 1024 * 1024 } });

router.post("/import/parse", checkPermission("students", "write"), importUpload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Excel ফাইল দিন" });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: "কোনো sheet পাওয়া যায়নি" });

    // প্রথম row = headers
    const headers = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = cell.text || (cell.value != null ? String(cell.value) : "");
      headers.push({ col: colNumber, name: val.trim() });
    });

    // Data rows (max 5 for preview)
    const preview = [];
    for (let r = 2; r <= Math.min(sheet.rowCount, 6); r++) {
      const row = sheet.getRow(r);
      const obj = {};
      headers.forEach(h => {
        const cell = row.getCell(h.col);
        obj[h.name] = cell.text || (cell.value != null ? String(cell.value) : "");
      });
      preview.push(obj);
    }

    // Auto-suggest mappings
    const suggestions = {};
    const autoMap = {
      "name": "name_en", "নাম": "name_en", "full name": "name_en", "student name": "name_en",
      "phone": "phone", "ফোন": "phone", "mobile": "phone", "contact": "phone",
      "email": "email", "ইমেইল": "email",
      "dob": "dob", "date of birth": "dob", "জন্ম তারিখ": "dob", "birth date": "dob",
      "gender": "gender", "লিঙ্গ": "gender", "sex": "gender",
      "passport": "passport_number", "পাসপোর্ট": "passport_number",
      "nid": "nid", "national id": "nid",
      "father": "father_name", "পিতা": "father_name", "father name": "father_name",
      "mother": "mother_name", "মাতা": "mother_name", "mother name": "mother_name",
      "address": "permanent_address", "ঠিকানা": "permanent_address",
      "country": "country", "দেশ": "country",
      "school": "school", "স্কুল": "school",
      "batch": "batch", "ব্যাচ": "batch",
      "status": "status", "source": "source",
      "branch": "branch", "ব্রাঞ্চ": "branch",
    };
    headers.forEach(h => {
      const lower = h.name.toLowerCase();
      for (const [key, field] of Object.entries(autoMap)) {
        if (lower.includes(key)) { suggestions[h.name] = field; break; }
      }
    });

    // Cleanup temp file
    const fs = require("fs");
    try { fs.unlinkSync(req.file.path); } catch {}

    res.json({
      headers: headers.map(h => h.name),
      totalRows: sheet.rowCount - 1,
      preview,
      suggestions,
    });
  } catch (err) {
    console.error("Import parse error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/students/import/mapped — Excel + mapping → bulk import
// FormData: file + mapping JSON
// ================================================================
router.post("/import/mapped", checkPermission("students", "write"), importUpload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Excel ফাইল দিন" });
    const mapping = JSON.parse(req.body.mapping || "{}");
    if (Object.keys(mapping).length === 0) return res.status(400).json({ error: "Mapping দিন" });

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];

    // Headers from row 1
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const val = cell.text || (cell.value != null ? String(cell.value) : "");
      headers.push({ col, name: val.trim() });
    });

    // Build student records from all data rows
    const records = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const student = { agency_id: agencyId, status: "ENROLLED" };
      let hasData = false;

      headers.forEach(h => {
        const systemField = mapping[h.name];
        if (!systemField) return;
        const cell = row.getCell(h.col);
        const val = cell.text || (cell.value != null ? String(cell.value).trim() : "");
        if (val) {
          student[systemField] = val;
          hasData = true;
        }
      });

      if (hasData && student.name_en) {
        // Valid columns only + auto-generate ID
        const year = new Date().getFullYear();
        const seq = String(r - 1).padStart(3, "0");
        const clean = { agency_id: agencyId, id: student.id || `S-${year}-IMP${seq}` };
        for (const col of STUDENT_COLUMNS) {
          if (col === "id") continue; // already set
          if (student[col] !== undefined && student[col] !== "") clean[col] = student[col];
        }
        if (!clean.status) clean.status = "ENROLLED";
        records.push(encryptSensitiveFields(clean));
      }
    }

    if (records.length === 0) {
      return res.status(400).json({ error: "কোনো valid student data পাওয়া যায়নি — name_en column ম্যাপ করুন" });
    }

    // Bulk insert
    const results = { success: 0, failed: 0, errors: [] };
    const { data, error } = await supabase.from("students").insert(records).select();

    if (error) {
      // Bulk fail → one by one
      for (let i = 0; i < records.length; i++) {
        const { error: sErr } = await supabase.from("students").insert(records[i]);
        if (sErr) { results.failed++; results.errors.push({ row: i + 2, name: records[i].name_en || `Row ${i + 2}`, error: "ডাটা সংরক্ষণ ব্যর্থ" }); }
        else { results.success++; }
      }
    } else {
      results.success = data.length;
    }

    // Cleanup
    const fs = require("fs");
    try { fs.unlinkSync(req.file.path); } catch {}

    // ক্যাশ invalidate — mapped import এ student count বদলায়
    if (results.success > 0) cache.invalidate(agencyId);

    res.json({ message: `${results.success} জন student import সফল, ${results.failed} জন ব্যর্থ`, ...results, total: records.length });
  } catch (err) {
    console.error("Import mapped error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/students/:id/portal-access — Admin portal access on/off + password set
// ================================================================
router.post("/:id/portal-access", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { enabled, password } = req.body;
  const updates = { portal_access: !!enabled };

  // Enable করলে এবং password দিলে hash করে সেট করো
  if (enabled && password) {
    updates.portal_password_hash = await bcrypt.hash(password, 12);
  }

  const { data, error } = await supabase.from("students").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select("id, name_en, portal_access").single();
  if (error) return res.status(500).json({ error: "আপডেট ব্যর্থ" });
  res.json(data);
}));

module.exports = router;
