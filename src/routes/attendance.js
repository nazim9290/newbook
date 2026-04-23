const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { getBranchFilter } = require("../lib/branchFilter");
const cache = require("../lib/cache");

const router = express.Router();
router.use(auth);

// ── GET /api/attendance/report?from=YYYY-MM-DD&to=YYYY-MM-DD&batch_id=xxx&intake=xxx ──
// Returns: { students, dates, attendance: { student_id: { date: status } }, summary }
// Used by: AttendancePage Report tab — matrix view + export
router.get("/report", asyncHandler(async (req, res) => {
  const { from, to, batch_id, intake, student_id } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from ও to date দিন" });

  const agencyId = req.user.agency_id;
  const branchFilter = getBranchFilter(req.user);

  // ── Students filter — batch / intake / branch / specific student ──
  let studentsQ = supabase.from("students")
    .select("id, name_en, batch, batch_id, intake, status, branch")
    .eq("agency_id", agencyId);
  if (branchFilter) studentsQ = studentsQ.eq("branch", branchFilter);
  if (batch_id && batch_id !== "All") studentsQ = studentsQ.eq("batch_id", batch_id);
  if (intake && intake !== "All") studentsQ = studentsQ.eq("intake", intake);
  if (student_id && student_id !== "All") studentsQ = studentsQ.eq("id", student_id);
  const { data: students } = await studentsQ;
  if (!students || students.length === 0) return res.json({ students: [], dates: [], attendance: {}, summary: {} });

  // ── Attendance records — date range + these students ──
  const studentIds = students.map(s => s.id);
  const { data: records } = await supabase.from("attendance")
    .select("student_id, date, status")
    .eq("agency_id", agencyId)
    .gte("date", from).lte("date", to)
    .in("student_id", studentIds);

  // ── Build matrix ──
  const attendance = {};
  students.forEach(s => { attendance[s.id] = {}; });
  const datesSet = new Set();
  (records || []).forEach(r => {
    const d = String(r.date).slice(0, 10);
    datesSet.add(d);
    if (!attendance[r.student_id]) attendance[r.student_id] = {};
    attendance[r.student_id][d] = r.status;
  });
  const dates = Array.from(datesSet).sort();

  // ── Per-student summary — present/absent/late counts + percentage ──
  const summary = {};
  students.forEach(s => {
    const att = attendance[s.id] || {};
    let present = 0, absent = 0, late = 0, total = 0;
    Object.values(att).forEach(status => {
      total++;
      const norm = (status || "").toLowerCase();
      if (norm === "p" || norm === "present") present++;
      else if (norm === "l" || norm === "late") late++;
      else absent++;
    });
    summary[s.id] = {
      present, absent, late, total,
      pct: total > 0 ? Math.round(((present + late) / total) * 100) : 0,
    };
  });

  res.json({ students, dates, attendance, summary });
}));

// GET /api/attendance?date=2026-03-24&batch=xyz
// agency_id ফিল্টার — শুধু নিজের agency-র attendance দেখাবে
router.get("/", asyncHandler(async (req, res) => {
  const { date, batch } = req.query;
  if (!date) return res.status(400).json({ error: "তারিখ দিন" });

  let query = supabase.from("attendance")
    .select("*")
    .eq("date", date)
    .eq("agency_id", req.user.agency_id);
  if (batch && batch !== "all") query = query.eq("batch_id", batch);

  // Branch filter — staff শুধু নিজ branch-এর students-এর attendance দেখবে
  const branchFilter = getBranchFilter(req.user);
  if (branchFilter) {
    // attendance table-এ branch নেই, তাই student_id দিয়ে filter
    const { data: branchStudents } = await supabase.from("students")
      .select("id")
      .eq("agency_id", req.user.agency_id)
      .eq("branch", branchFilter);
    const studentIds = (branchStudents || []).map(s => s.id);
    if (studentIds.length === 0) return res.json([]);
    query = query.in("student_id", studentIds);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// POST /api/attendance/save — bulk save for a date
// agency_id প্রতিটি record-এ যোগ হবে
router.post("/save", asyncHandler(async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: "date ও records দিন" });
  if (records.length > 200) return res.status(400).json({ error: "একসাথে সর্বোচ্চ ২০০ record" });

  const agencyId = req.user.agency_id;
  // marked_by UUID — user ID UUID না হলে null রাখি (crash prevent)
  const isValidUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const markedBy = isValidUuid(req.user.id) ? req.user.id : null;
  const batchId = isValidUuid(req.body.batch_id) ? req.body.batch_id : null;

  const rows = records.map((r) => ({
    date,
    student_id: r.student_id,
    status: r.status,
    batch_id: batchId,
    agency_id: agencyId,
    marked_by: markedBy,
  }));

  const { data, error } = await supabase
    .from("attendance")
    .upsert(rows, { onConflict: "student_id,date" })
    .select();

  if (error) { console.error("[Attendance Save]", error.message, error.details); return res.status(400).json({ error: "সার্ভার ত্রুটি: " + error.message }); }

  // Cache invalidate — attendance সেভ হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({ saved: data.length });
}));

module.exports = router;
