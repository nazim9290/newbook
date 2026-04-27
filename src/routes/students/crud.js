/**
 * crud.js — Student CRUD routes (list, detail, create, update, delete)
 *
 * GET    /            — list with search/filter/cursor pagination
 * GET    /:id         — detail with related data (edu, jp exam, family, sponsor, etc.)
 * POST   /            — new student create (with agency prefix ID)
 * PATCH  /:id         — update (with optimistic lock + sponsor/billing/batch/partner/school sync)
 * DELETE /:id         — delete
 */

const express = require("express");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../../lib/crypto");
const { checkPermission } = require("../../middleware/checkPermission");
const { logActivity } = require("../../lib/activityLog");
const { generateId } = require("../../lib/idGenerator");
const cache = require("../../lib/cache");
const { STUDENT_COLUMNS } = require("./_shared");

const router = express.Router();
router.use(auth);

// GET /api/students — list with search + filters (cursor-based pagination)
router.get("/", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { search, status, country, batch, school, branch, intake } = req.query;
  const { applyCursor, buildResponse } = require("../../lib/cursorPagination");

  let query = supabase.from("students").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);

  // Branch-based access — counselor/staff শুধু নিজের branch-এর student দেখবে
  const { getBranchFilter } = require("../../lib/branchFilter");
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
  if (intake && intake !== "All") query = query.eq("intake", intake);

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
    // updated_at / created_at — full ISO timestamp রাখো (optimistic lock-এ দরকার)
    const KEEP_FULL_TIMESTAMP = new Set(["updated_at", "created_at"]);
    const r = { ...s };
    for (const k of Object.keys(r)) {
      if (r[k] instanceof Date) r[k] = KEEP_FULL_TIMESTAMP.has(k) ? r[k].toISOString() : r[k].toISOString().slice(0, 10);
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
  // Date object → string normalize (updated_at/created_at full timestamp রাখো)
  for (const k of Object.keys(decrypted)) {
    if (decrypted[k] instanceof Date) decrypted[k] = (k === "updated_at" || k === "created_at") ? decrypted[k].toISOString() : decrypted[k].toISOString().slice(0, 10);
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
    if (current && current.updated_at) {
      const serverMs = new Date(current.updated_at).getTime();
      const clientMs = new Date(clientUpdatedAt).getTime();
      console.log("[Optimistic Lock]", req.params.id, { client: clientUpdatedAt, server: current.updated_at, clientMs, serverMs, diff: Math.abs(serverMs - clientMs) });
      if (serverMs !== clientMs) {
        return res.status(409).json({
          error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
          code: "CONFLICT",
          server_updated_at: current.updated_at,
          client_updated_at: clientUpdatedAt,
        });
      }
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
          } else if (["dob", "sign_date"].includes(col)) {
            // Date columns — PostgreSQL "" reject করে, তাই empty/null/undefined → null
            sponsorRecord[col] = sp[col] || null;
          } else {
            sponsorRecord[col] = sp[col];
          }
        }
      }
      sponsorRecord.updated_at = new Date().toISOString();

      // Tenant isolation — agency_id column-ও set করা ভাল practice
      sponsorRecord.agency_id = req.user.agency_id;

      // Upsert — student_id UNIQUE constraint দিয়ে conflict resolve
      const encSponsor = encryptSensitiveFields(sponsorRecord);
      const { error: spError } = await supabase.from("sponsors").upsert(encSponsor, { onConflict: "student_id" });
      if (spError) {
        // ── Sponsor save fail করলে আর silent থাকা যাবে না — response-এ flag করো ──
        console.error("[Sponsor Upsert]", spError.message);
        if (data) data._sponsor_save_error = spError.message || "Sponsor save failed";
      }
    } catch (spErr) {
      console.error("[Sponsor Upsert]", spErr.message);
      if (data) data._sponsor_save_error = spErr.message || "Sponsor save failed";
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

module.exports = router;
