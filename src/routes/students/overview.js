/**
 * overview.js — Student Quick Overview + Group Stats
 *
 * Attendance/dashboard থেকে দ্রুত student status check-এর জন্য:
 *
 *   POST /api/students/quick-stats   — body: { ids: [studentId, ...] }
 *     → { total, jlpt, submission, visa, vfs }
 *     এজেন্সি class ভিত্তিক group summary দেখতে পারে
 *
 *   GET  /api/students/:id/overview  — per-student deep info
 *     → { student, jp_exams, submissions, pre_departure }
 *     row-এ Eye icon click করলে modal-এ load হয়
 */

const express = require("express");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// ── helper: latest JLPT result per student থেকে category bucket ──
// jp_exams sorted by exam_date desc; প্রথমটাই latest
const bucketJlpt = (latest) => {
  if (!latest) return "no_exam";
  const result = String(latest.result || "").toLowerCase().trim();
  if (result === "pass" || result === "passed") return "passed";
  if (result === "fail" || result === "failed") return "failed";
  if (latest.exam_date) {
    const today = new Date().toISOString().slice(0, 10);
    return latest.exam_date > today ? "registered" : "result_pending";
  }
  return "registered";
};

// POST /api/students/quick-stats — ids array থেকে aggregated counts
router.post("/quick-stats", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  if (ids.length === 0) {
    return res.json({
      total: 0,
      jlpt: { passed: 0, failed: 0, registered: 0, result_pending: 0, no_exam: 0 },
      submission: { not_submitted: 0, submitted: 0, accepted: 0, coe_received: 0, rejected: 0 },
      visa: { granted: 0, applied: 0, vfs_scheduled: 0, none: 0 },
      vfs: { docs_submitted: 0, scheduled_only: 0, none: 0 },
      students_by_status: {},
    });
  }
  const agencyId = req.user.agency_id;

  // ── Students পিপলাইন status ──
  const { data: students, error: stuErr } = await supabase
    .from("students").select("id, status")
    .eq("agency_id", agencyId)
    .in("id", ids);
  if (stuErr) return res.status(500).json({ error: "সার্ভার ত্রুটি" });

  const studentMap = {};
  (students || []).forEach(s => { studentMap[s.id] = s; });
  const studentsByStatus = {};
  (students || []).forEach(s => {
    const k = s.status || "UNKNOWN";
    studentsByStatus[k] = (studentsByStatus[k] || 0) + 1;
  });

  // ── JLPT exams — সব fetch, latest pick per student ──
  const { data: jpExams } = await supabase
    .from("student_jp_exams").select("student_id, exam_date, result, level, exam_type, score")
    .in("student_id", ids)
    .order("exam_date", { ascending: false, nullsFirst: false });

  const latestPerStudent = {};
  (jpExams || []).forEach(e => {
    if (!latestPerStudent[e.student_id]) latestPerStudent[e.student_id] = e;
  });
  const jlpt = { passed: 0, failed: 0, registered: 0, result_pending: 0, no_exam: 0 };
  ids.forEach(id => { jlpt[bucketJlpt(latestPerStudent[id])] += 1; });

  // ── Submissions — latest per student ──
  const { data: subs } = await supabase
    .from("submissions").select("student_id, status, submission_date, coe_received_date")
    .eq("agency_id", agencyId)
    .in("student_id", ids)
    .order("submission_date", { ascending: false, nullsFirst: false });

  const latestSub = {};
  (subs || []).forEach(s => {
    if (!latestSub[s.student_id]) latestSub[s.student_id] = s;
  });
  const submission = { not_submitted: 0, submitted: 0, accepted: 0, coe_received: 0, rejected: 0 };
  ids.forEach(id => {
    const s = latestSub[id];
    if (!s) return submission.not_submitted += 1;
    const st = String(s.status || "").toLowerCase();
    if (s.coe_received_date || st === "coe_received") submission.coe_received += 1;
    else if (st === "accepted" || st === "minor_issues" || st === "forwarded_immigration") submission.accepted += 1;
    else if (st === "rejected" || st === "withdrawn" || st === "cancelled") submission.rejected += 1;
    else if (st === "submitted" || st === "issues_found" || st === "interview") submission.submitted += 1;
    else submission.submitted += 1;
  });

  // ── Pre-departure / VFS / Visa ──
  const { data: pds } = await supabase
    .from("pre_departure")
    .select("student_id, vfs_appointment_date, vfs_docs_submitted, visa_status, visa_date")
    .in("student_id", ids);

  const pdMap = {};
  (pds || []).forEach(p => { pdMap[p.student_id] = p; });
  const visa = { granted: 0, applied: 0, vfs_scheduled: 0, none: 0 };
  const vfs = { docs_submitted: 0, scheduled_only: 0, none: 0 };
  ids.forEach(id => {
    const p = pdMap[id] || {};
    const stuStatus = studentMap[id]?.status;
    const vstatus = String(p.visa_status || "").toLowerCase();
    if (vstatus === "granted" || stuStatus === "VISA_GRANTED" || stuStatus === "ARRIVED" || stuStatus === "COMPLETED") visa.granted += 1;
    else if (vstatus === "applied" || stuStatus === "VISA_APPLIED") visa.applied += 1;
    else if (p.vfs_appointment_date || stuStatus === "VFS_SCHEDULED") visa.vfs_scheduled += 1;
    else visa.none += 1;

    if (p.vfs_docs_submitted) vfs.docs_submitted += 1;
    else if (p.vfs_appointment_date) vfs.scheduled_only += 1;
    else vfs.none += 1;
  });

  res.json({
    total: ids.length,
    jlpt,
    submission,
    visa,
    vfs,
    students_by_status: studentsByStatus,
  });
}));

// POST /api/students/quick-stats/details — per-student flat row data for export
// body: { ids: [studentId, ...] }
// returns: { rows: [{ id, name_en, name_bn, phone, batch, ..., jlpt_latest_*, school_*, vfs_*, visa_*, coe_*, flight_* }] }
// Quick Stats Card-এর underlying data — এজেন্সি column পছন্দ করে CSV download করবে
router.post("/quick-stats/details", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  if (ids.length === 0) return res.json({ rows: [] });
  const agencyId = req.user.agency_id;
  const { decryptMany } = require("../../lib/crypto");

  // Students core
  const { data: students, error: stuErr } = await supabase
    .from("students")
    .select("id, name_en, name_bn, phone, status, country, school, batch, intake, branch, visa_type")
    .eq("agency_id", agencyId)
    .in("id", ids);
  if (stuErr) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  const decryptedStudents = decryptMany(students || []);

  // JLPT latest per student + count
  const { data: jpExams } = await supabase
    .from("student_jp_exams")
    .select("student_id, exam_type, level, score, result, exam_date")
    .in("student_id", ids)
    .order("exam_date", { ascending: false, nullsFirst: false });
  const jpLatest = {}; const jpCount = {};
  (jpExams || []).forEach(e => {
    if (!jpLatest[e.student_id]) jpLatest[e.student_id] = e;
    jpCount[e.student_id] = (jpCount[e.student_id] || 0) + 1;
  });

  // Submissions latest per student + school name
  const { data: subs } = await supabase
    .from("submissions")
    .select("student_id, status, submission_date, interview_date, coe_received_date, schools(name_en, name_jp)")
    .eq("agency_id", agencyId)
    .in("student_id", ids)
    .order("submission_date", { ascending: false, nullsFirst: false });
  const subLatest = {};
  (subs || []).forEach(s => { if (!subLatest[s.student_id]) subLatest[s.student_id] = s; });

  // Pre-departure rows
  const { data: pds } = await supabase
    .from("pre_departure")
    .select("student_id, coe_number, coe_date, vfs_appointment_date, vfs_docs_submitted, visa_status, visa_date, visa_expiry, flight_date, flight_number, arrival_confirmed")
    .eq("agency_id", agencyId)
    .in("student_id", ids);
  const pdMap = {};
  (pds || []).forEach(p => { pdMap[p.student_id] = p; });

  // Format for CSV — boolean → হ্যাঁ/না, dates → YYYY-MM-DD
  const fmtBool = (v) => v === true ? "হ্যাঁ" : v === false ? "না" : "";
  const fmtDate = (d) => {
    if (!d) return "";
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  };

  const rows = decryptedStudents.map(s => {
    const jp = jpLatest[s.id] || {};
    const sub = subLatest[s.id] || {};
    const subSchool = sub.schools?.name_en || sub.schools?.name_jp || "";
    const pd = pdMap[s.id] || {};
    return {
      id: s.id,
      name_en: s.name_en || "",
      name_bn: s.name_bn || "",
      phone: s.phone || "",
      status: s.status || "",
      country: s.country || "",
      school: s.school || "",
      batch: s.batch || "",
      intake: s.intake || "",
      branch: s.branch || "",
      visa_type: s.visa_type || "",
      // JLPT
      jlpt_latest_type: jp.exam_type || "",
      jlpt_latest_level: jp.level || "",
      jlpt_latest_result: jp.result || "",
      jlpt_latest_score: jp.score || "",
      jlpt_latest_date: fmtDate(jp.exam_date),
      jlpt_attempts: jpCount[s.id] || 0,
      // School submission
      school_submitted_to: subSchool,
      school_submission_status: sub.status || "",
      school_submission_date: fmtDate(sub.submission_date),
      school_interview_date: fmtDate(sub.interview_date),
      school_coe_received_date: fmtDate(sub.coe_received_date),
      // VFS / Visa / COE / Flight
      coe_number: pd.coe_number || "",
      coe_date: fmtDate(pd.coe_date),
      vfs_appointment_date: fmtDate(pd.vfs_appointment_date),
      vfs_docs_submitted: fmtBool(pd.vfs_docs_submitted),
      visa_status: pd.visa_status || "",
      visa_date: fmtDate(pd.visa_date),
      visa_expiry: fmtDate(pd.visa_expiry),
      flight_date: fmtDate(pd.flight_date),
      flight_number: pd.flight_number || "",
      arrived: fmtBool(pd.arrival_confirmed),
    };
  });

  res.json({ rows });
}));

// GET /api/students/:id/overview — single student-এর key info modal-এর জন্য
router.get("/:id/overview", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.id;

  // Student core
  const { data: student, error: stuErr } = await supabase
    .from("students")
    .select("id, name_en, name_bn, status, country, school, batch, intake, branch, visa_type, photo_url, phone")
    .eq("agency_id", agencyId).eq("id", studentId).single();
  if (stuErr || !student) return res.status(404).json({ error: "স্টুডেন্ট পাওয়া যায়নি" });

  // JLPT exams
  const { data: jpExams } = await supabase
    .from("student_jp_exams")
    .select("id, exam_type, level, score, result, exam_date")
    .eq("student_id", studentId)
    .order("exam_date", { ascending: false, nullsFirst: false });

  // Submissions with school name
  const { data: submissions } = await supabase
    .from("submissions")
    .select("id, school_id, status, submission_date, interview_date, coe_received_date, recheck_count, schools(name_en, name_jp)")
    .eq("agency_id", agencyId)
    .eq("student_id", studentId)
    .order("submission_date", { ascending: false, nullsFirst: false });

  // Pre-departure (single row per student)
  const { data: pdRows } = await supabase
    .from("pre_departure")
    .select("coe_number, coe_date, vfs_appointment_date, vfs_docs_submitted, visa_status, visa_date, visa_expiry, flight_date, flight_number, arrival_confirmed, health_status, tuition_remitted, tuition_date")
    .eq("agency_id", agencyId)
    .eq("student_id", studentId)
    .limit(1);

  res.json({
    student: {
      id: student.id,
      name_en: student.name_en,
      name_bn: student.name_bn,
      status: student.status,
      country: student.country,
      school: student.school,
      batch: student.batch,
      intake: student.intake,
      branch: student.branch,
      visa_type: student.visa_type,
      photo_url: student.photo_url,
      phone: student.phone,
    },
    jp_exams: jpExams || [],
    submissions: (submissions || []).map(s => ({
      id: s.id,
      school_id: s.school_id,
      school_name: s.schools?.name_en || s.schools?.name_jp || "—",
      status: s.status,
      submission_date: s.submission_date,
      interview_date: s.interview_date,
      coe_received_date: s.coe_received_date,
      recheck_count: s.recheck_count || 0,
    })),
    pre_departure: (pdRows && pdRows[0]) ? pdRows[0] : null,
  });
}));

module.exports = router;
