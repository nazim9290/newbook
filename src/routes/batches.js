const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { logActivity } = require("../lib/activityLog");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// ═══════════════════════════════════════════════════════
// Auto-calculate study hours — ক্লাসের দিন ও সময় থেকে ঘণ্টা হিসাব
// start_date, end_date, class_days, class_hours_per_day থেকে
// total_classes, total_hours, weekly_hours বের করে
// holidays array পাস করলে ছুটির দিনগুলো বাদ যাবে
// ═══════════════════════════════════════════════════════
function calculateBatchHours(batch, holidays = []) {
  const start = new Date(batch.start_date);
  const end = new Date(batch.end_date);
  const classDays = batch.class_days || [];
  const hoursPerDay = parseFloat(batch.class_hours_per_day) || 2;

  // প্রয়োজনীয় ডাটা না থাকলে খালি ফেরত দাও
  if (!batch.start_date || !batch.end_date || classDays.length === 0) return {};
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return {};

  // সপ্তাহের দিনগুলোকে JS day number-এ convert (0=Sun, 1=Mon, ...)
  const dayMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
  const classDayNums = classDays.map(d => dayMap[d]).filter(n => n !== undefined);

  // ── Holiday dates Set তৈরি — O(1) lookup-এর জন্য ──
  // fixed holidays: সরাসরি date string (YYYY-MM-DD)
  // recurring holidays: প্রতিবছর একই MM-DD — batch range-এর সব year-এ expand
  const holidaySet = new Set();
  holidays.forEach(h => {
    const hDate = typeof h.date === "string" ? h.date : (h.date ? new Date(h.date).toISOString().slice(0, 10) : null);
    if (!hDate) return;
    if (h.recurring) {
      // recurring ছুটি — MM-DD অংশটা নিয়ে batch range-এর প্রতিটি year-এ যোগ করো
      const md = hDate.slice(5); // "MM-DD"
      for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
        holidaySet.add(`${y}-${md}`);
      }
    } else {
      // fixed ছুটি — শুধু ঐ তারিখ
      holidaySet.add(hDate.slice(0, 10));
    }
  });

  // start → end পর্যন্ত ক্লাসের দিন গণনা (ছুটি বাদে)
  let totalDays = 0;
  let current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    // ক্লাসের দিন হতে হবে AND ছুটি হতে পারবে না
    if (classDayNums.includes(current.getDay()) && !holidaySet.has(dateStr)) {
      totalDays++;
    }
    current.setDate(current.getDate() + 1);
  }

  // সাপ্তাহিক ঘণ্টা = ক্লাসের দিন × প্রতিদিন ঘণ্টা
  const weeklyHours = classDays.length * hoursPerDay;
  // মোট ঘণ্টা = মোট ক্লাসের দিন × প্রতিদিন ঘণ্টা
  const totalHours = totalDays * hoursPerDay;

  return { total_classes: totalDays, total_hours: totalHours, weekly_hours: weeklyHours };
}

// GET /api/batches
router.get("/", asyncHandler(async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("batches").select("*").eq("agency_id", req.user.agency_id).order("start_date", { ascending: false });
  if (status && status !== "All") query = query.eq("status", status);
  // Branch-based access — counselor/staff শুধু নিজের branch-এর batch দেখবে
  const { getBranchFilter } = require("../lib/branchFilter");
  const userBranch = getBranchFilter(req.user);
  if (userBranch) query = query.eq("branch", userBranch);
  else if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });

  // একটি query-তে সব batch-এর student count আনা (N+1 সমস্যা সমাধান)
  if (data && data.length > 0) {
    try {
      const pool = supabase.pool;
      const batchIds = data.map(b => b.id);
      const [{ rows: counts }, { rows: passed }] = await Promise.all([
        pool.query(
          `SELECT batch_id, COUNT(*)::int AS count
           FROM batch_students
           WHERE batch_id = ANY($1)
           GROUP BY batch_id`,
          [batchIds]
        ),
        // পরীক্ষায় পাস — batch-এর enrolled students-দের মধ্যে কতজন exam pass করেছে
        pool.query(
          `SELECT bs.batch_id, COUNT(DISTINCT e.student_id)::int AS passed
           FROM batch_students bs
           JOIN student_jp_exams e ON e.student_id = bs.student_id AND e.result = 'Passed'
           WHERE bs.batch_id = ANY($1)
           GROUP BY bs.batch_id`,
          [batchIds]
        ),
      ]);
      const countMap = Object.fromEntries(counts.map(r => [r.batch_id, r.count]));
      const passedMap = Object.fromEntries(passed.map(r => [r.batch_id, r.passed]));
      data.forEach(b => {
        b.enrolledCount = countMap[b.id] || 0;
        b.passedCount = passedMap[b.id] || 0;
      });
    } catch { data.forEach(b => { b.enrolledCount = 0; b.passedCount = 0; }); }
  }

  res.json(data);
}));

// GET /api/batches/:id — with enrolled students
router.get("/:id", asyncHandler(async (req, res) => {
  const { data: batch, error } = await supabase
    .from("batches")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (error) return res.status(404).json({ error: "Batch পাওয়া যায়নি" });

  const { data: enrollments } = await supabase
    .from("batch_students")
    .select("*, students(name_en, phone, status)")
    .eq("batch_id", req.params.id)
    .eq("agency_id", req.user.agency_id);

  // Class tests — scores সহ load (agency_id filter — cross-agency data leak prevention)
  const { data: tests } = await supabase.from("class_tests")
    .select("*, class_test_scores!test_id(student_id, score)")
    .eq("batch_id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .order("date", { ascending: false });

  res.json({ ...batch, enrollments: enrollments || [], tests: tests || [] });
}));

// POST /api/batches — নতুন ব্যাচ তৈরি
// agency_id JWT থেকে auto-set, branch frontend থেকে আসে
router.post("/", asyncHandler(async (req, res) => {
  // class_days string হিসেবে আসলে JSON parse করতে হবে
  const body = { ...req.body };
  // Valid batch columns only — unknown keys filter out
  const BATCH_COLS = ["name","country","level","start_date","end_date","capacity","schedule","teacher","status","class_days","class_hours_per_day","class_time","branch"];
  const record = { agency_id: req.user.agency_id };
  for (const col of BATCH_COLS) {
    if (req.body[col] !== undefined) record[col] = req.body[col];
  }
  if (!record.branch) record.branch = req.user.branch || "Main";
  // class_days → JSONB column-এ stringify করে পাঠাতে হবে
  if (record.class_days) {
    if (typeof record.class_days === "string") {
      // already string — validate JSON
      try { JSON.parse(record.class_days); } catch { record.class_days = "[]"; }
    } else {
      // array → stringify
      record.class_days = JSON.stringify(record.class_days);
    }
  }
  const { data, error } = await supabase.from("batches").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Auto-calculate — ক্লাসের দিন/ঘণ্টা থেকে total_classes, total_hours, weekly_hours হিসাব
  // ছুটির দিনগুলো বাদ দিয়ে হিসাব (holidays table থেকে)
  const { data: holidays } = await supabase.from("holidays").select("date, recurring").eq("agency_id", req.user.agency_id);
  const calculated = calculateBatchHours(data, holidays || []);
  if (calculated.total_hours) {
    const { data: updated } = await supabase.from("batches").update(calculated).eq("id", data.id).select().single();
    if (updated) Object.assign(data, updated);
  }

  // Cache invalidate — নতুন ব্যাচ তৈরি হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — নতুন ব্যাচ তৈরি
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "batches",
    recordId: data.id, description: `নতুন ব্যাচ: ${data.name || ""}`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// PATCH /api/batches/:id
router.patch("/:id", asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("batches").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — পেজ রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: current.updated_at,
      });
    }
  }

  // প্রতিটি save-এ updated_at নতুন করে সেট — পরবর্তী conflict check-এর জন্য
  const updates = { ...req.body, updated_at: new Date().toISOString() };

  const { data, error } = await supabase.from("batches").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // Auto-calculate — ক্লাসের দিন/ঘণ্টা থেকে total_classes, total_hours, weekly_hours হিসাব
  // ছুটির দিনগুলো বাদ দিয়ে হিসাব (holidays table থেকে)
  const { data: holidays } = await supabase.from("holidays").select("date, recurring").eq("agency_id", req.user.agency_id);
  const calculated = calculateBatchHours(data, holidays || []);
  if (calculated.total_hours) {
    const { data: updated } = await supabase.from("batches").update(calculated).eq("id", data.id).select().single();
    if (updated) Object.assign(data, updated);
  }

  // Cache invalidate — ব্যাচ আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — ব্যাচ আপডেট
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "batches",
    recordId: req.params.id, description: `ব্যাচ আপডেট: ${data.name || req.params.id}`, ip: req.ip }).catch(() => {});

  res.json(data);
}));

// POST /api/batches/:id/enroll — enroll student
// batch_students junction table + student.batch ফিল্ড sync
router.post("/:id/enroll", asyncHandler(async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: "student_id দিন" });

  // ব্যাচ তথ্য আনো — নাম sync করতে
  const { data: batch } = await supabase.from("batches").select("id, name").eq("id", req.params.id).single();
  if (!batch) return res.status(404).json({ error: "Batch পাওয়া যায়নি" });

  // batch_students junction table-এ enroll
  const { data, error } = await supabase
    .from("batch_students")
    .insert({ batch_id: req.params.id, student_id, agency_id: req.user.agency_id })
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // ── student.batch ও batch_id sync — ব্যাচ নাম ও ID student record-এ সেট ──
  try {
    await supabase.from("students")
      .update({ batch: batch.name, batch_id: batch.id })
      .eq("id", student_id)
      .eq("agency_id", req.user.agency_id);
  } catch (e) { console.error("[Batch Sync]", e.message); }

  // Cache invalidate — enrollment হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Activity log — ব্যাচে student enroll
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "batches",
    recordId: data.id, description: `Batch enrollment: ${student_id} → ${batch.name || req.params.id}`, ip: req.ip }).catch(() => {});

  res.status(201).json(data);
}));

// POST /api/batches/:id/tests — ক্লাস টেস্ট যোগ (total_marks + individual scores)
router.post("/:id/tests", asyncHandler(async (req, res) => {
  const { test_name, date, total_marks, scores } = req.body;
  if (!test_name) return res.status(400).json({ error: "টেস্টের নাম দিন" });

  // class_tests table-এ test তৈরি
  const { data, error } = await supabase.from("class_tests").insert({
    agency_id: req.user.agency_id,
    batch_id: req.params.id,
    test_name, date: date || null,
    total_marks: total_marks || 100,
  }).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // class_test_scores table-এ প্রতি student-এর score insert
  if (scores && typeof scores === "object") {
    const scoreRows = Object.entries(scores)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([student_id, score]) => ({ test_id: data.id, student_id, score: parseInt(score) || 0 }));
    if (scoreRows.length > 0) {
      const { error: scoreErr } = await supabase.from("class_test_scores").insert(scoreRows);
      if (scoreErr) console.error("[DB class_test_scores]", scoreErr.message);
    }
  }

  // Cache invalidate
  cache.invalidate(req.user.agency_id);

  // Activity log
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "class_tests",
    recordId: data.id, description: `Class test: ${test_name}`, ip: req.ip }).catch(() => {});

  // scores সহ return
  const { data: full } = await supabase.from("class_tests")
    .select("*, class_test_scores!test_id(student_id, score)")
    .eq("id", data.id).single();
  res.status(201).json(full || data);
}));

// PUT /api/batches/:id/tests/:testId — ক্লাস টেস্ট আপডেট
router.put("/:id/tests/:testId", asyncHandler(async (req, res) => {
  const { test_name, date, total_marks, scores } = req.body;

  // class_tests table আপডেট
  const updates = {};
  if (test_name !== undefined) updates.test_name = test_name;
  if (date !== undefined) updates.date = date || null;
  if (total_marks !== undefined) updates.total_marks = total_marks;

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from("class_tests").update(updates)
      .eq("id", req.params.testId).eq("agency_id", req.user.agency_id);
    if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "আপডেট ব্যর্থ" }); }
  }

  // scores আপডেট — পুরানো মুছে নতুন insert (upsert)
  if (scores && typeof scores === "object") {
    const scoreRows = Object.entries(scores)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([student_id, score]) => ({ test_id: req.params.testId, student_id, score: parseInt(score) || 0 }));
    // পুরানো scores মুছে দাও
    await supabase.from("class_test_scores").delete().eq("test_id", req.params.testId);
    // নতুন scores insert
    if (scoreRows.length > 0) {
      const { error: scoreErr } = await supabase.from("class_test_scores").insert(scoreRows);
      if (scoreErr) console.error("[DB class_test_scores]", scoreErr.message);
    }
  }

  // Cache invalidate
  cache.invalidate(req.user.agency_id);

  // Activity log
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "class_tests",
    recordId: req.params.testId, description: `Class test updated: ${test_name || ""}`, ip: req.ip }).catch(() => {});

  // Full data return
  const { data: full } = await supabase.from("class_tests")
    .select("*, class_test_scores!test_id(student_id, score)")
    .eq("id", req.params.testId).single();
  res.json(full);
}));

// GET /api/batches/:id/tests — ক্লাস টেস্ট তালিকা (scores সহ)
router.get("/:id/tests", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("class_tests")
    .select("*, class_test_scores!test_id(student_id, score)")
    .eq("batch_id", req.params.id).order("date", { ascending: false });
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

module.exports = router;
