const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { encryptSensitiveFields, decryptMany } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");
const { logActivity } = require("../lib/activityLog");
const { generateId } = require("../lib/idGenerator");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// GET /api/visitors — search, filter, cursor-based pagination
router.get("/", checkPermission("visitors", "read"), asyncHandler(async (req, res) => {
  const { search, status, status_in, exclude_status, branch } = req.query;
  const { applyCursor, buildResponse } = require("../lib/cursorPagination");

  let query = supabase.from("visitors").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);

  // Branch-based access
  const { getBranchFilter } = require("../lib/branchFilter");
  const userBranch = getBranchFilter(req.user);
  if (userBranch) query = query.eq("branch", userBranch);

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }
  if (status_in) {
    const statuses = status_in.split(",").filter(Boolean);
    if (statuses.length > 0) query = query.in("status", statuses);
  } else if (status && status !== "All") {
    query = query.eq("status", status);
  }
  if (exclude_status) {
    const excluded = exclude_status.split(",").filter(Boolean);
    excluded.forEach(s => { query = query.neq("status", s); });
  }
  if (branch && branch !== "All") query = query.eq("branch", branch);

  // Cursor-based pagination
  query = applyCursor(query, req.query, { sortCol: "created_at", ascending: false });

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  const mapped = (data || []).map(v => ({
    ...v,
    name_en: v.name_en || v.name,
    date: v.visit_date || v.date,
    lastFollowUp: v.last_follow_up,
    interested_countries: v.interested_countries || [],
    interested_intake: v.interested_intake || "",
  }));

  const response = buildResponse(decryptMany(mapped), req.query, { sortCol: "created_at", total: count });
  res.json(response);
}));

// POST /api/visitors — নতুন visitor তৈরি (agency prefix ID সহ)
router.post("/", checkPermission("visitors", "write"), asyncHandler(async (req, res) => {
  const body = req.body;
  const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

  // ── Agency prefix দিয়ে Visitor display ID generate ──
  const displayId = await generateId(agencyId, "visitor");

  // Frontend field → DB column mapping
  const record = {
    agency_id: agencyId,
    display_id: displayId,
    name: body.name || body.name_en || "",
    name_bn: body.name_bn || body.name || "",
    phone: body.phone || "",
    guardian_phone: body.guardian_phone || null,
    email: body.email || null,
    dob: body.dob || null,
    gender: body.gender || null,
    address: body.address || null,
    education: body.education ? JSON.stringify(body.education) : "[]",
    has_jp_cert: body.has_jp_cert || false,
    jp_exam_type: body.jp_exam_type || null,
    jp_level: body.jp_level || null,
    jp_score: body.jp_score || null,
    visa_type: body.visa_type || null,
    interested_countries: body.interested_countries || ["Japan"],
    interested_intake: body.interested_intake || null,
    budget_concern: body.budget_concern || false,
    source: body.source || "Walk-in",
    referral_info: body.referral_info || null,
    agent_id: body.agent_id || null,
    counselor: body.counselor || null,
    branch: body.branch || "Main",
    status: body.status || "Interested",
    notes: body.notes || null,
    next_follow_up: body.next_follow_up || null,
    visit_date: body.date || body.visit_date || new Date().toISOString().slice(0, 10),
  };

  const { data, error } = await supabase.from("visitors").insert(encryptSensitiveFields(record)).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — নতুন visitor তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "visitors",
    recordId: data.id, description: `নতুন ভিজিটর: ${data.name || ""}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — নতুন visitor যোগে dashboard counts বদলায়
  cache.invalidate(req.user.agency_id);

  // Response-এ frontend format-এ field mapping
  const mapped = { ...data, name_en: data.name, date: data.visit_date, lastFollowUp: data.last_follow_up };
  res.status(201).json(mapped);
}));

// PATCH /api/visitors/:id — frontend camelCase → DB snake_case mapping
const VISITOR_FIELD_MAP = {
  lastFollowUp: "last_follow_up", nextFollowUp: "next_follow_up",
  visitDate: "visit_date", guardianPhone: "guardian_phone",
  hasJpCert: "has_jp_cert", jpExamType: "jp_exam_type",
  jpLevel: "jp_level", jpScore: "jp_score",
  interestedCountries: "interested_countries", interestedIntake: "interested_intake",
  budgetConcern: "budget_concern", referralInfo: "referral_info",
  agentName: "agent_name", createdBy: "created_by",
  name_en: "name", date: "visit_date",
};
router.patch("/:id", checkPermission("visitors", "write"), asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = req.body;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("visitors").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // Frontend field names → DB column names convert
  const DATE_COLS = ["visit_date", "last_follow_up", "next_follow_up", "dob"];
  // Valid DB columns — এগুলোই শুধু update হবে, বাকি সব ignore
  const VALID_COLS = [
    "name", "name_en", "name_bn", "phone", "guardian_phone", "email",
    "dob", "gender", "blood_group", "address", "education",
    "has_jp_cert", "jp_exam_type", "jp_exam_type_other", "jp_level", "jp_score",
    "visa_type", "visa_type_other", "interested_countries", "interested_intake",
    "budget_concern", "source", "agent_id", "agent_name", "referral_info",
    "counselor", "branch", "status", "notes", "next_follow_up", "last_follow_up",
    "visit_date",
  ];
  const updates = {};
  for (const [key, val] of Object.entries(req.body)) {
    const dbKey = VISITOR_FIELD_MAP[key] || key;
    if (!VALID_COLS.includes(dbKey)) continue; // unknown column skip
    // Date empty string → null (PostgreSQL date column "" reject করে)
    if (DATE_COLS.includes(dbKey) && (val === "" || val === null)) {
      updates[dbKey] = null;
    } else if (val !== undefined) {
      // JSONB fields — array/object → JSON string
      if (dbKey === "education" && typeof val !== "string") {
        updates[dbKey] = JSON.stringify(val);
      } else {
        updates[dbKey] = val;
      }
    }
  }

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("visitors")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — visitor আপডেট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "visitors",
    recordId: req.params.id, description: `ভিজিটর আপডেট: ${data.name || req.params.id}${req.body.status ? ` → ${req.body.status}` : ""}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — visitor status বদলে dashboard refresh দরকার
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// POST /api/visitors/:id/convert — convert visitor to student
router.post("/:id/convert", checkPermission("visitors", "write"), asyncHandler(async (req, res) => {
  const { data: visitor, error: vErr } = await supabase
    .from("visitors")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();

  if (vErr) return res.status(404).json({ error: "Visitor পাওয়া যায়নি" });

  // Student ID generate — agency prefix সহ
  const { generateId } = require("../lib/idGenerator");
  const agencyId = req.user.agency_id;
  const studentId = await generateId(agencyId, "student");

  // Visitor → Student — সব তথ্য সঠিকভাবে transfer
  const studentData = {
    id: studentId,
    agency_id: agencyId,
    name_en: visitor.name || visitor.name_en,
    name_bn: visitor.name_bn,
    phone: visitor.phone,
    email: visitor.email,
    dob: visitor.dob || null,
    gender: visitor.gender || null,
    blood_group: visitor.blood_group || null,
    permanent_address: visitor.address || null,
    source: visitor.source,
    agent_id: visitor.agent_id || null,
    referral_info: visitor.referral_info || null,
    counselor: visitor.counselor || null,
    branch: visitor.branch,
    country: (visitor.interested_countries && visitor.interested_countries[0]) || "Japan",
    intake: visitor.interested_intake || null,
    internal_notes: visitor.notes || null,
    status: "ENROLLED",
    ...req.body, // frontend থেকে অতিরিক্ত data override
  };

  const { data: student, error: sErr } = await supabase
    .from("students")
    .insert(encryptSensitiveFields(studentData))
    .select()
    .single();

  if (sErr) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // ── Education transfer — visitor education array → student_education table-এ ──
  try {
    const eduArr = typeof visitor.education === "string" ? JSON.parse(visitor.education) : visitor.education;
    if (Array.isArray(eduArr) && eduArr.length > 0) {
      const eduRows = eduArr
        .filter(e => e.level || e.institution || e.year)
        .map(e => ({
          student_id: studentId, agency_id: agencyId,
          level: e.level || "", school_name: e.institution || e.board || "",
          year: e.year || null, board: e.board || "", gpa: e.gpa || "",
          group_name: e.subject || e.group || "",
        }));
      if (eduRows.length > 0) {
        await supabase.from("student_education").insert(eduRows);
      }
    }
  } catch (eduErr) { console.error("[Edu Transfer]", eduErr.message); }

  // JP Exam data transfer — visitor-এ JP cert থাকলে student_jp_exams-এ যোগ
  if (visitor.has_jp_cert && visitor.jp_exam_type) {
    try {
      await supabase.from("student_jp_exams").insert({
        student_id: studentId, agency_id: agencyId,
        exam_type: visitor.jp_exam_type, level: visitor.jp_level || null,
        score: visitor.jp_score || null, result: "Pass",
      });
    } catch (jpErr) { console.error("[JP Exam Transfer]", jpErr.message); }
  }

  await supabase.from("visitors").update({ status: "converted", converted_student_id: student.id }).eq("id", req.params.id);

  // Activity log — visitor → student কনভার্ট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "visitors",
    recordId: student.id, description: `ভিজিটর→স্টুডেন্ট কনভার্ট: ${visitor.name || ""} → ${student.id}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — visitor→student convert এ সব count বদলায়
  cache.invalidate(req.user.agency_id);

  res.status(201).json(student);
}));

// DELETE /api/visitors/:id
router.delete("/:id", checkPermission("visitors", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("visitors")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Activity log — visitor মুছে ফেলা
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "delete", module: "visitors",
    recordId: req.params.id, description: `ভিজিটর মুছে ফেলা: ${req.params.id}`, ip: req.ip }).catch(() => {});

  // ক্যাশ invalidate — visitor delete এ count বদলায়
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

module.exports = router;
