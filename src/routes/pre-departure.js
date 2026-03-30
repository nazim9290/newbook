/**
 * pre-departure.js — Pre-Departure & VFS API Route
 *
 * COE → Health → Tuition → VFS → Visa → Flight → Arrival tracking
 * students table থেকে COE+ stage-এর students আনে,
 * pre_departure table-এ checklist data রাখে
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/supabase");

// ── GET /api/pre-departure — departure-eligible students + checklist ──
router.get("/", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const pool = supabase.pool;

  // COE+ stage-এ থাকা students আনো + pre_departure data join
  const { rows } = await pool.query(`
    SELECT
      s.id, s.name_en, s.name_bn, s.phone, s.status, s.country,
      s.school, s.batch, s.intake,
      pd.id AS pd_id, pd.coe_number, pd.coe_date,
      pd.health_status, pd.health_date, pd.health_notes,
      pd.tuition_amount, pd.tuition_remitted, pd.tuition_date,
      pd.vfs_appointment_date, pd.vfs_docs_submitted,
      pd.visa_status, pd.visa_date, pd.visa_expiry,
      pd.flight_date, pd.flight_number, pd.arrival_confirmed,
      pd.notes AS pd_notes
    FROM students s
    LEFT JOIN pre_departure pd ON pd.student_id = s.id
    WHERE s.agency_id = $1
      AND s.status IN (
        'COE_RECEIVED','HEALTH_CHECK','TUITION_REMITTED','VFS_SCHEDULED',
        'VISA_APPLIED','VISA_GRANTED','PRE_DEPARTURE','ARRIVED','COMPLETED'
      )
    ORDER BY s.updated_at DESC
  `, [agencyId]);

  // প্রতিটি student-এর departure data format করো
  const students = rows.map(r => ({
    id: r.id,
    name: r.name_bn || r.name_en,
    name_en: r.name_en,
    phone: r.phone,
    status: r.status,
    country: r.country || "Japan",
    school: r.school || "—",
    batch: r.batch || "—",
    // Pre-departure data
    pd_id: r.pd_id,
    coe: { number: r.coe_number || "", date: r.coe_date },
    health: { status: r.health_status || "pending", date: r.health_date, notes: r.health_notes },
    tuition: { amount: Number(r.tuition_amount || 0), remitted: r.tuition_remitted || false, date: r.tuition_date },
    vfs: { appointmentDate: r.vfs_appointment_date, docsSubmitted: r.vfs_docs_submitted || false },
    visa: { status: r.visa_status || "pending", date: r.visa_date, expiry: r.visa_expiry },
    flight: { date: r.flight_date, number: r.flight_number },
    arrivalConfirmed: r.arrival_confirmed || false,
    notes: r.pd_notes || "",
  }));

  // ── KPI ──
  const kpi = {
    total: students.length,
    visaGranted: students.filter(s => ["VISA_GRANTED","ARRIVED","COMPLETED"].includes(s.status)).length,
    healthPending: students.filter(s => s.health.status !== "done").length,
    vfsPending: students.filter(s => !s.vfs.docsSubmitted).length,
  };

  res.json({ students, kpi });
}));

// ── POST /api/pre-departure/:studentId — departure data তৈরি/আপডেট ──
router.post("/:studentId", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.studentId;
  const body = req.body;

  // Upsert — আছে তো update, নাহলে insert
  const { data, error } = await supabase.from("pre_departure").upsert({
    agency_id: agencyId,
    student_id: studentId,
    coe_number: body.coe_number,
    coe_date: body.coe_date || null,
    health_status: body.health_status || "pending",
    health_date: body.health_date || null,
    health_notes: body.health_notes || "",
    tuition_amount: body.tuition_amount || 0,
    tuition_remitted: body.tuition_remitted || false,
    tuition_date: body.tuition_date || null,
    vfs_appointment_date: body.vfs_appointment_date || null,
    vfs_docs_submitted: body.vfs_docs_submitted || false,
    visa_status: body.visa_status || "pending",
    visa_date: body.visa_date || null,
    visa_expiry: body.visa_expiry || null,
    flight_date: body.flight_date || null,
    flight_number: body.flight_number || "",
    arrival_confirmed: body.arrival_confirmed || false,
    notes: body.notes || "",
  }, { onConflict: "student_id" }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

module.exports = router;
