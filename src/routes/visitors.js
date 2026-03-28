const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { encryptSensitiveFields, decryptMany } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");
const { generateId } = require("../lib/idGenerator");

const router = express.Router();
router.use(auth);

// GET /api/visitors
router.get("/", checkPermission("visitors", "read"), asyncHandler(async (req, res) => {
  const { search, status, branch, page = 1, limit: rawLimit = 50 } = req.query;
  const limit = Math.min(Math.max(parseInt(rawLimit) || 50, 1), 100); // সর্বোচ্চ ১০০
  const safePage = Math.max(parseInt(page) || 1, 1);
  const offset = (safePage - 1) * limit;

  let query = supabase.from("visitors").select("*", { count: "exact" });

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // DB columns → frontend field names mapping
  const mapped = (data || []).map(v => ({
    ...v,
    name_en: v.name_en || v.name,        // frontend name_en চায়
    date: v.visit_date || v.date,          // frontend date চায়
    lastFollowUp: v.last_follow_up,        // frontend lastFollowUp চায়
    interested_countries: v.interested_countries || [],
    interested_intake: v.interested_intake || "",
  }));

  res.json({ data: decryptMany(mapped), total: count });
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
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }

  // Response-এ frontend format-এ field mapping
  const mapped = { ...data, name_en: data.name, date: data.visit_date, lastFollowUp: data.last_follow_up };
  res.status(201).json(mapped);
}));

// PATCH /api/visitors/:id
router.patch("/:id", checkPermission("visitors", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("visitors")
    .update(req.body)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: process.env.NODE_ENV !== "production" ? error.message : "সার্ভার ত্রুটি" }); }
  res.json(data);
}));

// POST /api/visitors/:id/convert — convert visitor to student
router.post("/:id/convert", checkPermission("visitors", "write"), asyncHandler(async (req, res) => {
  const { data: visitor, error: vErr } = await supabase
    .from("visitors")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (vErr) return res.status(404).json({ error: "Visitor পাওয়া যায়নি" });

  const { data: student, error: sErr } = await supabase
    .from("students")
    .insert(encryptSensitiveFields({
      name_en: visitor.name_en,
      name_bn: visitor.name_bn,
      phone: visitor.phone,
      email: visitor.email,
      source: visitor.source,
      branch: visitor.branch,
      status: "ENROLLED",
      ...req.body,
    }))
    .select()
    .single();

  if (sErr) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  await supabase.from("visitors").update({ status: "converted", converted_student_id: student.id }).eq("id", req.params.id);

  res.status(201).json(student);
}));

module.exports = router;
