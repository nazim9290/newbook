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

// GET /api/students — list with search + filters (cursor-based pagination)
router.get("/", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { search, status, country, batch, school, branch } = req.query;
  const { applyCursor, buildResponse } = require("../lib/cursorPagination");

  let query = supabase.from("students").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);

  // Branch-based access — counselor/staff শুধু নিজের branch-এর student দেখবে
  const { getBranchFilter } = require("../lib/branchFilter");
  const userBranch = getBranchFilter(req.user);
  if (userBranch) query = query.eq("branch", userBranch);

  if (search) {
    query = query.or(`name_en.ilike.%${search}%,phone.ilike.%${search}%,id.ilike.%${search}%`);
  }
  if (status && status !== "All") query = query.eq("status", status);
  if (country && country !== "All") query = query.eq("country", country);
  if (batch && batch !== "All") query = query.eq("batch", batch);
  if (school && school !== "All") query = query.eq("school", school);
  if (branch && branch !== "All") query = query.eq("branch", branch);

  // Cursor-based pagination — cursor=timestamp অথবা page=N (backward compatible)
  query = applyCursor(query, req.query, { sortCol: "created_at", ascending: false });

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // ── school_id / batch_id থেকে নাম resolve — একবার bulk lookup ──
  const schoolIds = [...new Set((data || []).map(s => s.school_id).filter(Boolean))];
  const batchIds = [...new Set((data || []).map(s => s.batch_id).filter(Boolean))];
  const schoolMap = {};
  const batchMap = {};
  if (schoolIds.length > 0) {
    const { data: schools } = await supabase.from("schools").select("id, name_en").in("id", schoolIds);
    (schools || []).forEach(sc => { schoolMap[sc.id] = sc.name_en; });
  }
  if (batchIds.length > 0) {
    const { data: batches } = await supabase.from("batches").select("id, name").in("id", batchIds);
    (batches || []).forEach(b => { batchMap[b.id] = b.name; });
  }

  // DB fields → frontend field mapping + Date object normalize
  const mapped = (data || []).map(s => {
    // Date object → "YYYY-MM-DD" string (pg driver date columns কে Date object return করে)
    const r = { ...s };
    for (const k of Object.keys(r)) {
      if (r[k] instanceof Date) r[k] = r[k].toISOString().slice(0, 10);
    }
    r.batch = batchMap[s.batch_id] || s.batch || "";
    r.school = schoolMap[s.school_id] || s.school || "";
    r.passport = s.passport_number || "";
    r.father = s.father_name || "";
    r.mother = s.mother_name || "";
    r.created = r.created_at?.slice?.(0, 10) || "";
    return r;
  });

  const response = buildResponse(decryptMany(mapped), req.query, { sortCol: "created_at", total: count });
  res.json(response);
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
  // Date object → string normalize
  for (const k of Object.keys(decrypted)) {
    if (decrypted[k] instanceof Date) decrypted[k] = decrypted[k].toISOString().slice(0, 10);
  }
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
  "intake", "visa_type", "source", "agent_id", "partner_id", "referral_info", "student_type",
  "counselor", "branch", "gdrive_folder_url", "photo_url", "internal_notes",
  // Resume fields — Excel入学願書 support
  "birth_place", "occupation", "reason_for_study", "future_plan", "study_subject",
  // Passport page fields — emergency contact, spouse, parents DOB/occupation
  "spouse_name", "emergency_contact", "emergency_phone",
  "father_dob", "father_occupation", "mother_dob", "mother_occupation",
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

  // UUID columns — empty string হলে null করো (PostgreSQL UUID type empty string accept করে না)
  ["school_id", "batch_id", "agent_id", "partner_id", "assignee_id"].forEach(k => {
    if (updates[k] === "") updates[k] = null;
  });

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

  if (error) { console.error("[DB] update students:", error.message, "| body keys:", Object.keys(updates).join(",")); return res.status(400).json({ error: error.message || "সার্ভার ত্রুটি" }); }

  // ── Sponsor upsert — frontend sponsor object থাকলে sponsors table-এ save ──
  if (body.sponsor && typeof body.sponsor === "object") {
    try {
      const sp = body.sponsor;
      // sponsors table-এর valid columns — বাকি সব ignore
      const SPONSOR_COLS = [
        "name", "name_en", "relationship", "phone", "address", "nid", "dob",
        "father_name", "mother_name", "present_address", "permanent_address",
        "company_name", "company_address", "company_phone", "trade_license", "trade_license_no", "work_address", "tin",
        "income_year_1", "income_year_2", "income_year_3",
        "income_source_1", "income_source_2", "income_source_3",
        "annual_income_y1", "annual_income_y2", "annual_income_y3",
        "tax_y1", "tax_y2", "tax_y3",
        "statement", "payment_to_student", "payment_to_school", "sign_date",
        "tuition_jpy", "living_jpy_monthly", "payment_method", "exchange_rate",
        "fund_formation", "notes",
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

  // ── Batch sync — batch_id পরিবর্তন হলে batch_students junction table আপডেট ──
  // JP Study auto-create করা হয় না — resume-এ agency+batch fallback থেকে resolve হয়
  if (body.batch_id && data.batch_id) {
    try {
      // পুরনো enrollment থাকলে মুছে নতুনটা যোগ
      await supabase.from("batch_students").delete().eq("student_id", req.params.id);
      await supabase.from("batch_students").insert({
        batch_id: data.batch_id, student_id: req.params.id, agency_id: req.user.agency_id,
      });
      // batch name sync — batch_id থেকে name আনো
      if (!body.batch) {
        const { data: batchInfo } = await supabase.from("batches").select("name").eq("id", data.batch_id).single();
        if (batchInfo) await supabase.from("students").update({ batch: batchInfo.name }).eq("id", req.params.id);
      }
    } catch (e) { console.error("[Batch Sync]", e.message); }
  }

  // ── Partner sync — partner_id পরিবর্তন হলে partner_students junction table আপডেট ──
  if (body.partner_id !== undefined && data) {
    try {
      // পুরনো partner link মুছে দাও
      await supabase.from("partner_students").delete().eq("student_id", req.params.id);
      // নতুন partner_id থাকলে junction record তৈরি
      if (body.partner_id) {
        // partner-এর commission_rate দিয়ে fee set
        const { data: partner } = await supabase.from("partner_agencies").select("commission_rate").eq("id", body.partner_id).single();
        await supabase.from("partner_students").insert({
          partner_id: body.partner_id,
          student_id: req.params.id,
          student_name: data.name_en || "",
          fee: partner?.commission_rate || 0,
          paid: 0,
          status: "active",
        });
      }
    } catch (e) { console.error("[Partner Sync]", e.message); }
  }

  // ── School sync — school name থেকে school_id, বা school_id থেকে name sync ──
  if (body.school && !body.school_id) {
    // নাম দিয়ে school_id খুঁজো
    try {
      const { data: sch } = await supabase.from("schools").select("id").eq("name_en", body.school).eq("agency_id", req.user.agency_id).single();
      if (sch) await supabase.from("students").update({ school_id: sch.id }).eq("id", req.params.id);
    } catch {}
  } else if (body.school_id && !body.school) {
    // ID দিয়ে name খুঁজো
    try {
      const { data: sch } = await supabase.from("schools").select("name_en").eq("id", body.school_id).single();
      if (sch) await supabase.from("students").update({ school: sch.name_en }).eq("id", req.params.id);
    } catch {}
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

// POST /api/students/:id/exam-result — JLPT/NAT পরীক্ষার ফলাফল save/update
router.post("/:id/exam-result", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { exam_type, level, score, result, exam_date, exam_id } = req.body;
  if (!exam_type) return res.status(400).json({ error: "পরীক্ষার ধরন দিন" });

  // exam_id থাকলে update, না থাকলে insert
  if (exam_id) {
    const { data, error } = await supabase.from("student_jp_exams").update({
      exam_type, level, score: score || null, result: result || null,
      exam_date: exam_date || null,
    }).eq("id", exam_id).eq("agency_id", req.user.agency_id).select().single();
    if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "আপডেট ব্যর্থ" }); }
    return res.json(data);
  }

  // নতুন insert
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
    level, school_name, year, board, gpa, group_name,
    entrance_year: entrance_year || "", address: address || "", school_type: school_type || "",
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

router.patch("/:id/education/:eduId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { level, school_name, year, board, gpa, group_name, entrance_year, address, school_type } = req.body;
  const { data, error } = await supabase.from("student_education").update({
    level, school_name, year, board, gpa, group_name,
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

// PATCH /api/students/:id/jp-study/:jsId — জাপানি ভাষা শিক্ষা ইতিহাস আপডেট
router.patch("/:id/jp-study/:jsId", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { institution, address, period_from, period_to, total_hours } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (institution !== undefined) update.institution = institution;
  if (address !== undefined) update.address = address;
  if (period_from !== undefined) update.period_from = period_from;
  if (period_to !== undefined) update.period_to = period_to;
  if (total_hours !== undefined) update.total_hours = total_hours;
  const { data, error } = await supabase.from("student_jp_study").update(update).eq("id", req.params.jsId).eq("student_id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
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

  // ── সব student ফিল্ড — ইউজার bulk import করতে পারবে ──
  const cols = [
    // ── Personal Info ──
    { header: "Full Name (English) *", key: "name_en", width: 28 },
    { header: "Name (カタカナ)", key: "name_katakana", width: 20 },
    { header: "Phone *", key: "phone", width: 18 },
    { header: "WhatsApp", key: "whatsapp", width: 18 },
    { header: "Email", key: "email", width: 24 },
    { header: "Date of Birth", key: "dob", width: 14 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Marital Status", key: "marital_status", width: 12 },
    { header: "Nationality", key: "nationality", width: 14 },
    { header: "Blood Group", key: "blood_group", width: 10 },
    { header: "Place of Birth", key: "birth_place", width: 18 },
    { header: "Occupation", key: "occupation", width: 15 },
    // ── Passport & NID ──
    { header: "NID", key: "nid", width: 20 },
    { header: "Passport No", key: "passport_number", width: 15 },
    { header: "Passport Issue Date", key: "passport_issue", width: 14 },
    { header: "Passport Expiry Date", key: "passport_expiry", width: 14 },
    // ── Address ──
    { header: "Permanent Address", key: "permanent_address", width: 35 },
    { header: "Current Address", key: "current_address", width: 35 },
    // ── Family ──
    { header: "Father Name", key: "father_name", width: 22 },
    { header: "Mother Name", key: "mother_name", width: 22 },
    { header: "Spouse Name", key: "spouse_name", width: 20 },
    { header: "Emergency Contact", key: "emergency_contact", width: 20 },
    { header: "Emergency Phone", key: "emergency_phone", width: 18 },
    // ── Destination & Status ──
    { header: "Country", key: "country", width: 12 },
    { header: "School", key: "school", width: 25 },
    { header: "Batch", key: "batch", width: 15 },
    { header: "Intake", key: "intake", width: 15 },
    { header: "Visa Type", key: "visa_type", width: 18 },
    { header: "Student Type", key: "student_type", width: 12 },
    { header: "Branch", key: "branch", width: 12 },
    { header: "Source", key: "source", width: 14 },
    { header: "Counselor", key: "counselor", width: 15 },
    // ── Study Plan ──
    { header: "Reason for Study", key: "reason_for_study", width: 30 },
    { header: "Future Plan", key: "future_plan", width: 25 },
    { header: "Study Subject", key: "study_subject", width: 20 },
  ];
  ws.columns = cols;

  // Header row style — cyan background, white bold text
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF06B6D4" } };
  headerRow.alignment = { horizontal: "center" };

  // Required columns (* চিহ্নিত) red background — Name (1) ও Phone (3)
  [1, 3].forEach(col => {
    const cell = headerRow.getCell(col);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF43F5E" } };
  });

  // ── Row 2 = নির্দেশনা সারি — প্রতিটি ফিল্ডের জন্য hint ──
  const guideRow = ws.addRow([
    "Required — Full name in English CAPS", "カタカナ name", "Required — 01XXXXXXXXX",
    "If different from phone", "Optional", "YYYY-MM-DD", "Male / Female / Other",
    "Single / Married / Divorced", "Bangladeshi", "A+ / B+ / O+ / AB+ etc.",
    "Place of birth", "Student / Business etc.",
    "17-digit NID number", "Passport number", "YYYY-MM-DD", "YYYY-MM-DD",
    "Village, Upazila, District", "Current address if different",
    "Father full name", "Mother full name", "Spouse name", "Emergency person name", "Emergency phone",
    "Japan / Germany / Korea", "School name", "e.g. April 2026", "e.g. April 2026",
    "Language Student / SSW / TITP", "Own / Partner", "Main / Chattogram / Sylhet",
    "Facebook / Walk-in / Agent / Referral", "Counselor name",
    "Reason for studying abroad", "Future career plan", "Subject of study",
  ]);
  guideRow.font = { italic: true, size: 9, color: { argb: "FF666666" } };
  guideRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFDE7" } };

  // ── Row 3 = Sample data ──
  ws.addRow([
    "MOHAMMAD RAHIM", "モハマド ラヒム", "01811111111",
    "01811111111", "rahim@gmail.com", "1998-03-12", "Male",
    "Single", "Bangladeshi", "B+", "Comilla", "Student",
    "1998123456789", "BK1234567", "2020-01-15", "2030-01-14",
    "Comilla, Bangladesh", "", "Abdul Karim", "Fatema Begum",
    "", "", "",
    "Japan", "Kobe Japanese Language School", "April 2026", "April 2026",
    "Language Student", "Own", "Main", "Facebook", "Mina",
    "To learn Japanese and work in Japan", "IT engineer in Japan", "Computer Science",
  ]);

  // ── Phone, NID, WhatsApp, Emergency Phone → Text format (leading zero রক্ষা) ──
  const textCols = [3, 4, 13, 23]; // phone, whatsapp, nid, emergency_phone
  for (let r = 1; r <= 200; r++) {
    textCols.forEach(c => {
      ws.getCell(r, c).numFmt = "@";
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

    // ── Data rows — empty row skip করো, max 5 preview ──
    const preview = [];
    let dataRowCount = 0;
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      // row-তে কোনো data আছে কিনা চেক করো
      let hasData = false;
      headers.forEach(h => {
        const cell = row.getCell(h.col);
        const val = cell.text || (cell.value != null ? String(cell.value).trim() : "");
        if (val) hasData = true;
      });
      if (!hasData) continue;
      dataRowCount++;
      if (preview.length < 5) {
        const obj = {};
        headers.forEach(h => {
          const cell = row.getCell(h.col);
          obj[h.name] = cell.text || (cell.value != null ? String(cell.value) : "");
        });
        preview.push(obj);
      }
    }

    // Auto-suggest mappings
    const suggestions = {};
    // ── Auto-mapping — Excel header text → system field ──
    const autoMap = {
      // Personal
      "name": "name_en", "নাম": "name_en", "full name": "name_en", "student name": "name_en",
      "katakana": "name_katakana", "カタカナ": "name_katakana",
      "phone": "phone", "ফোন": "phone", "mobile": "phone", "contact": "phone",
      "whatsapp": "whatsapp",
      "email": "email", "ইমেইল": "email",
      "dob": "dob", "date of birth": "dob", "জন্ম তারিখ": "dob", "birth date": "dob",
      "gender": "gender", "লিঙ্গ": "gender", "sex": "gender",
      "marital": "marital_status", "বৈবাহিক": "marital_status",
      "nationality": "nationality", "জাতীয়তা": "nationality",
      "blood": "blood_group", "রক্ত": "blood_group",
      "birth place": "birth_place", "place of birth": "birth_place", "জন্মস্থান": "birth_place",
      "occupation": "occupation", "পেশা": "occupation",
      // Passport & NID
      "nid": "nid", "national id": "nid",
      "passport": "passport_number", "পাসপোর্ট": "passport_number",
      "passport issue": "passport_issue",
      "passport expiry": "passport_expiry",
      // Address
      "permanent address": "permanent_address", "address": "permanent_address", "ঠিকানা": "permanent_address",
      "current address": "current_address",
      // Family
      "father": "father_name", "পিতা": "father_name", "father name": "father_name",
      "mother": "mother_name", "মাতা": "mother_name", "mother name": "mother_name",
      "spouse": "spouse_name", "স্বামী": "spouse_name", "স্ত্রী": "spouse_name",
      "emergency contact": "emergency_contact",
      "emergency phone": "emergency_phone",
      // Destination
      "country": "country", "দেশ": "country",
      "school": "school", "স্কুল": "school",
      "batch": "batch", "ব্যাচ": "batch",
      "intake": "intake",
      "visa type": "visa_type", "visa": "visa_type",
      "student type": "student_type", "type": "student_type",
      "branch": "branch", "ব্রাঞ্চ": "branch",
      "source": "source",
      "counselor": "counselor", "কাউন্সেলর": "counselor",
      // Study Plan
      "reason": "reason_for_study",
      "future plan": "future_plan",
      "study subject": "study_subject", "subject": "study_subject",
      "status": "status",
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
      totalRows: dataRowCount,
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

// ═══════════════════════════════════════════════════════
// POST /api/students/:id/generate-study-purpose
// AI দিয়ে "Purpose of Study" letter generate করে student record-এ save
// প্রথমবার generate → save → পরবর্তীতে saved data ব্যবহার হবে
// ═══════════════════════════════════════════════════════
router.post("/:id/generate-study-purpose", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "AI API key configured নেই" });

  // ── Credit check — প্রতি generation-এ 5 credit লাগে ──
  const AI_CREDITS = 5;
  const { data: agencyCredits } = await supabase.from("agencies").select("ocr_credits").eq("id", req.user.agency_id).single();
  const balance = agencyCredits?.ocr_credits || 0;
  if (balance < AI_CREDITS) {
    return res.status(402).json({
      error: `AI credit অপর্যাপ্ত (${balance}/${AI_CREDITS})`,
      code: "NO_CREDITS", credits: balance, required: AI_CREDITS,
    });
  }

  // ── Student data আনো — AI prompt-এ ব্যবহার হবে ──
  const { data: student } = await supabase
    .from("students")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  // ── JP Exam data আনো ──
  const { data: jpExams } = await supabase
    .from("student_jp_exams")
    .select("exam_type, level, score, result")
    .eq("student_id", req.params.id);

  // ── JP Study history আনো ──
  const { data: jpStudy } = await supabase
    .from("student_jp_study")
    .select("institution, hours")
    .eq("student_id", req.params.id);

  // ── Education আনো ──
  const { data: education } = await supabase
    .from("student_education")
    .select("level, school_name, year, gpa, group_name")
    .eq("student_id", req.params.id);

  // ── School info ──
  let schoolName = student.school || "";
  let schoolCity = "";
  if (student.school_id) {
    const { data: school } = await supabase.from("schools").select("name_en, city").eq("id", student.school_id).single();
    if (school) { schoolName = school.name_en || schoolName; schoolCity = school.city || ""; }
  }

  // ── Agency info আনো — current institution হিসেবে agency name ব্যবহার হবে ──
  const { data: agency } = await supabase.from("agencies").select("name, settings").eq("id", req.user.agency_id).single();
  const agencyName = agency?.name || "";
  const customPrompt = agency?.settings?.study_purpose_prompt || "";

  // ── Validation — required fields check (force=true হলে skip) ──
  const force = req.body?.force === true;
  const missing = [];
  if (!student.name_en) missing.push("Full Name (Profile → Personal Info)");
  if (!student.dob) missing.push("Date of Birth (Profile → Personal Info)");
  if (!(education || []).length) missing.push("Education — SSC/HSC (Profile → Education → Add)");
  if (!schoolName) missing.push("Japanese School (Profile → Destination Info → School)");

  if (missing.length > 0 && !force) {
    return res.status(400).json({
      error: "Purpose of Study generate করতে নিচের তথ্যগুলো আগে পূরণ করুন",
      code: "MISSING_FIELDS",
      missing_fields: missing,
    });
  }

  // ── Student context — AI-কে student-এর সব data দেওয়া হচ্ছে ──
  const age = student.dob ? Math.floor((Date.now() - new Date(student.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : "";
  const jpExamInfo = (jpExams || []).map(e => `${e.exam_type} ${e.level} (${e.result})`).join(", ") || "None";
  // JP Study — record থাকলে সেটা, না থাকলে agency-ই default training provider (180 hours)
  const hasJpStudy = (jpStudy || []).length > 0;
  const jpStudyInfo = hasJpStudy
    ? (jpStudy || []).map(s => `${s.institution} (${s.hours || "?"} hours)`).join(", ")
    : `${agencyName} (180 hours)`;
  const totalJpHours = hasJpStudy
    ? (jpStudy || []).reduce((sum, s) => sum + (parseInt(s.hours) || 0), 0)
    : 180;

  // ── Education sorting — সর্বশেষ শিক্ষা আগে, subject/group সহ ──
  const eduLevels = { "Masters": 6, "Bachelor": 5, "Degree": 5, "Honours": 5, "Diploma": 4, "HSC": 3, "Alim": 3, "SSC": 2, "Dakhil": 2, "Other": 1 };
  const sortedEdu = (education || []).sort((a, b) => (eduLevels[b.level] || 0) - (eduLevels[a.level] || 0));
  const lastEdu = sortedEdu[0] || {};
  const eduInfo = sortedEdu.map(e => `${e.level}: ${e.school_name || ""} (Year: ${e.year || "?"}, GPA: ${e.gpa || "?"}, Subject: ${e.group_name || "General"})`).join("; ");

  const studentContext = `
Student Information:
- Full Name: ${student.name_en}
- Age: ${age} years old
- Gender: ${student.gender || "Male"}
- Country of Birth: ${student.nationality || "Bangladesh"}
- Last Education Level: ${lastEdu.level || "HSC"} (${lastEdu.group_name || "General"})
- Last Education Institution: ${lastEdu.school_name || ""}
- Education Subject/Group: ${lastEdu.group_name || "General"}
- Full Education History: ${eduInfo}
- Current Institution (Agency/Academy): ${agencyName}
- Study Subject in Japan: ${student.study_subject || "Japanese Language"}
- Japanese Language Exams: ${jpExamInfo}
- Japanese Study History: ${jpStudyInfo}
- Total Japanese Training Hours: ${totalJpHours || "150+"}
- Daily Self-Study Hours: 2 hours
- Japanese School in Japan: ${schoolName}${schoolCity ? ` (${schoolCity}, Japan)` : ""}
- Target Country: Japan
- Visa Type: ${student.visa_type || "Language Student"}
`;

  // ── Default system prompt — agency customize না করলে এটা ব্যবহার হবে ──
  const defaultPrompt = `You are a professional academic writer specializing in Japanese student visa applications.

Your ONLY task is to write a "Purpose of Study" letter.

You MUST always write EXACTLY 6 paragraphs in this fixed order:

PARAGRAPH 1 — Self Introduction
Write about: full name, age, country of birth, completed exams/degrees, current institution and subject, and future academic goal.

PARAGRAPH 2 — Purpose of Studying [Subject]
Write about: why the student chose this specific subject, what skills and knowledge it provides, career opportunities (employment + entrepreneurship), and salary/professional value.

PARAGRAPH 3 — Reasons for Choosing Japan
Write about: Japan's excellence in this field, international value of a Japanese degree, part-time work opportunities, internal scholarship availability, JLPT and job market connection, and Japan's economic strength (3rd largest economy).

PARAGRAPH 4 — Japanese Language Preparation
Write about: which JLPT level completed, name of language academy, total training hours, and daily self-study practice hours.

PARAGRAPH 5 — School Admission & Expectation
Write about: name of the Japanese language school, its location/city, quality of teachers, and the student's hope and belief that this school will support their academic dream.

PARAGRAPH 6 — Future Plan & Commitment
Write about: commitment to disciplined and hardworking life in Japan, plan to excel academically, intention to work at a Japanese company after graduation, and long-term settlement plan in Japan.

STRICT RULES:
- Always write exactly 6 paragraphs — no more, no less
- No bullet points — flowing prose only
- No subject line, no greeting (do not write "Dear Sir/Madam")
- Formal, sincere, and natural tone
- Each paragraph must be self-contained and focused on its designated topic only
- Do not mix topics between paragraphs
- Word count: STRICTLY 300–350 words total — MUST fit in ONE page
- Each paragraph should be 3-5 sentences MAXIMUM — keep it concise
- Separate each paragraph with a blank line

HUMANIZE — CRITICAL:
- Write like a real Bangladeshi student wrote it, NOT like AI generated
- Use simple, natural English — avoid complex vocabulary and flowery language
- Vary sentence lengths — mix short and long sentences naturally
- Avoid overused AI phrases: "furthermore", "moreover", "in addition", "it is worth noting", "I am writing to express", "embark on a journey", "pursue my passion", "hone my skills"
- Avoid starting multiple sentences with "I" — vary sentence structure
- Include small personal touches that feel genuine (e.g., "My father encouraged me", "I first became interested when...")
- Use contractions occasionally (I've, I'm, it's) to sound natural
- Keep it slightly imperfect — a real student letter is not perfectly polished
- Sound motivated but not dramatic — no "burning desire" or "lifelong dream"
- Each paragraph should flow naturally into the next, like a real person telling their story
- The overall tone should feel like a sincere, thoughtful student — not a marketing brochure`;

  const systemPrompt = customPrompt || defaultPrompt;

  try {
    // ── Claude Haiku API call — Purpose of Study generate ──
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `${systemPrompt}\n\n${studentContext}\n\nWrite the Purpose of Study letter now. Return ONLY the letter text, nothing else.`
        }],
      }),
    });

    if (!response.ok) {
      console.error("[AI] Study purpose generation failed:", response.status);
      return res.status(502).json({ error: "AI generation ব্যর্থ" });
    }

    const result = await response.json();
    const purposeText = result.content?.[0]?.text || "";

    if (!purposeText.trim()) return res.status(500).json({ error: "AI empty response" });

    // ── Student record-এ save — পরবর্তীতে আর AI call লাগবে না ──
    await supabase.from("students")
      .update({
        reason_for_study: purposeText,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("agency_id", req.user.agency_id);

    // ── Credit deduct (5 credits) — generation সফল হলেই কাটবে ──
    const { pool } = supabase;
    try {
      await pool.query("UPDATE agencies SET ocr_credits = GREATEST(0, ocr_credits - $1) WHERE id = $2", [AI_CREDITS, req.user.agency_id]);
      // Usage log
      await supabase.from("ocr_usage").insert({
        agency_id: req.user.agency_id, user_id: req.user.id,
        doc_type: "purpose_of_study", engine: "haiku",
        credits_used: AI_CREDITS, confidence: "high",
        fields_extracted: 1, file_name: student.name_en || "",
      });
      // Credit transaction log
      const newBalance = balance - AI_CREDITS;
      await supabase.from("ocr_credit_log").insert({
        agency_id: req.user.agency_id, amount: -AI_CREDITS, balance_after: newBalance,
        type: "ai_generate", description: `Purpose of Study: ${student.name_en}`,
        created_by: req.user.id,
      });
    } catch (e) { console.error("[Credit Deduct]", e.message); }

    // Activity log
    logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "students",
      recordId: req.params.id, description: `AI Purpose of Study generated: ${student.name_en}`, ip: req.ip }).catch(() => {});

    res.json({
      success: true,
      reason_for_study: purposeText,
      word_count: purposeText.split(/\s+/).length,
      credits_used: AI_CREDITS,
      credits_remaining: Math.max(0, balance - AI_CREDITS),
    });

  } catch (err) {
    console.error("[AI Error]", err.message);
    res.status(500).json({ error: "AI generation failed: " + err.message });
  }
}));

module.exports = router;
