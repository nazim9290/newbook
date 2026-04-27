/**
 * pre-departure.js — Pre-Departure & VFS API Route
 *
 * Country-specific departure tracking:
 * Japan: COE → Health → Tuition → VFS → Visa → Flight
 * Germany: Admission → Blocked Account → Insurance → VFS → Visa → Flight
 * Korea: Admission/TOPIK → D-4 Visa → Health → Flight → Arrival+ARC
 *
 * students table থেকে COE+ stage-এর students আনে,
 * pre_departure table-এ checklist data রাখে
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getBranchFilter } = require("../lib/branchFilter");
const cache = require("../lib/cache");

// ── Multer config — pre-departure document upload ──
const pdUploadDir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"), "pre-departure");
if (!fs.existsSync(pdUploadDir)) fs.mkdirSync(pdUploadDir, { recursive: true });

const pdStorage = multer.diskStorage({
  // ফাইল save করার ডিরেক্টরি
  destination: (req, file, cb) => cb(null, pdUploadDir),
  // unique filename — studentId_timestamp_originalname
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\u0980-\u09FF]/g, "_");
    cb(null, `${req.params.studentId}_${Date.now()}_${safe}`);
  },
});
const pdUpload = multer({
  storage: pdStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // সর্বোচ্চ 10MB
  fileFilter: (req, file, cb) => {
    // PDF, ছবি, Word ফাইল allow
    if (/\.(pdf|jpg|jpeg|png|webp|doc|docx)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("শুধু PDF, JPG, PNG, WEBP, DOC, DOCX ফাইল আপলোড করুন"));
  },
});

// ── GET /api/pre-departure — departure-eligible students + checklist ──
router.get("/", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const pool = supabase.pool;

  // Branch filter — staff শুধু নিজ branch-এর students দেখবে
  const branchFilter = getBranchFilter(req.user);

  // COE+ stage-এ থাকা students আনো + pre_departure data join (checklists + deadlines সহ)
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
      pd.notes AS pd_notes,
      pd.checklists, pd.deadlines, pd.files,
      -- Germany-specific columns
      pd.admission_letter_status, pd.admission_letter_date,
      pd.blocked_account_status, pd.blocked_account_date, pd.blocked_account_amount,
      pd.insurance_status, pd.insurance_date, pd.insurance_provider,
      -- Korea-specific columns
      pd.admission_topik_status, pd.admission_topik_date, pd.admission_topik_score,
      pd.d4_visa_status, pd.d4_visa_date,
      pd.arc_card_status, pd.arc_card_date,
      pd.updated_at AS pd_updated_at
    FROM students s
    LEFT JOIN pre_departure pd ON pd.student_id = s.id
    WHERE s.agency_id = $1
      AND s.status IN (
        'COE_RECEIVED','HEALTH_CHECK','TUITION_REMITTED','VFS_SCHEDULED',
        'VISA_APPLIED','VISA_GRANTED','PRE_DEPARTURE','ARRIVED','COMPLETED'
      )
      AND ($2::text IS NULL OR s.branch = $2)
    ORDER BY s.updated_at DESC
  `, [agencyId, branchFilter]);

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
    checklists: r.checklists || {},
    deadlines: r.deadlines || {},
    files: r.files || [],
    // Germany-specific data
    admissionLetter: { status: r.admission_letter_status || "pending", date: r.admission_letter_date },
    blockedAccount: { status: r.blocked_account_status || "pending", date: r.blocked_account_date, amount: Number(r.blocked_account_amount || 0) },
    insurance: { status: r.insurance_status || "pending", date: r.insurance_date, provider: r.insurance_provider || "" },
    // Korea-specific data
    admissionTopik: { status: r.admission_topik_status || "pending", date: r.admission_topik_date, score: r.admission_topik_score || "" },
    d4Visa: { status: r.d4_visa_status || "pending", date: r.d4_visa_date },
    arcCard: { status: r.arc_card_status || "pending", date: r.arc_card_date },
    pd_updated_at: r.pd_updated_at || null, // optimistic lock — frontend-এ save-এর সময় পাঠাবে
  }));

  // ── KPI — overdue deadline গণনা সহ ──
  const now = new Date().toISOString().slice(0, 10);
  const overdueCount = students.filter(s => {
    if (!s.deadlines || typeof s.deadlines !== "object") return false;
    return Object.values(s.deadlines).some(d => d && d < now);
  }).length;

  const kpi = {
    total: students.length,
    visaGranted: students.filter(s => ["VISA_GRANTED","ARRIVED","COMPLETED"].includes(s.status)).length,
    healthPending: students.filter(s => s.health.status !== "done").length,
    vfsPending: students.filter(s => !s.vfs.docsSubmitted).length,
    overdue: overdueCount,
  };

  res.json({ students, kpi });
}));

// ── POST /api/pre-departure/:studentId — departure data তৈরি/আপডেট ──
router.post("/:studentId", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.studentId;
  const body = req.body;

  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  const { updated_at: clientUpdatedAt } = body;
  if (clientUpdatedAt) {
    const { data: existing } = await supabase.from("pre_departure")
      .select("updated_at")
      .eq("student_id", studentId)
      .eq("agency_id", agencyId)
      .single();
    if (existing && existing.updated_at && new Date(existing.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: existing.updated_at,
      });
    }
  }

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
    checklists: body.checklists || {},
    deadlines: body.deadlines || {},
    // Germany-specific fields
    admission_letter_status: body.admission_letter_status || "pending",
    admission_letter_date: body.admission_letter_date || null,
    blocked_account_status: body.blocked_account_status || "pending",
    blocked_account_date: body.blocked_account_date || null,
    blocked_account_amount: body.blocked_account_amount || 0,
    insurance_status: body.insurance_status || "pending",
    insurance_date: body.insurance_date || null,
    insurance_provider: body.insurance_provider || "",
    // Korea-specific fields
    admission_topik_status: body.admission_topik_status || "pending",
    admission_topik_date: body.admission_topik_date || null,
    admission_topik_score: body.admission_topik_score || "",
    d4_visa_status: body.d4_visa_status || "pending",
    d4_visa_date: body.d4_visa_date || null,
    arc_card_status: body.arc_card_status || "pending",
    arc_card_date: body.arc_card_date || null,
    updated_at: new Date().toISOString(), // প্রতিটি save-এ timestamp আপডেট — optimistic lock
  }, { onConflict: "student_id" }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

  // ── Auto-sync: Pre-Departure milestone → Student pipeline status আপডেট ──
  // Pre-Departure মডিউলে milestone complete হলে student-এর status auto-update
  const studentUpdate = {};
  if (body.arrival_confirmed) {
    // গন্তব্যে পৌঁছানো কনফার্ম হলে ARRIVED
    studentUpdate.status = "ARRIVED";
  } else if (body.visa_status === "granted") {
    // ভিসা পেয়েছে
    studentUpdate.status = "VISA_GRANTED";
  } else if (body.vfs_docs_submitted && body.vfs_appointment_date) {
    // VFS appointment ও ডক জমা হয়েছে
    studentUpdate.status = "VISA_APPLIED";
  } else if (body.tuition_remitted && body.health_status === "done") {
    // টিউশন remitted + Health check done
    studentUpdate.status = "TUITION_REMITTED";
  } else if (body.health_status === "done") {
    // Health check সম্পন্ন
    studentUpdate.status = "HEALTH_CHECK";
  }

  // Cache invalidate — pre-departure data আপডেট হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  // Student status update — যদি milestone-ভিত্তিক পরিবর্তন হয়
  if (studentUpdate.status) {
    try {
      const pool = supabase.pool;
      await pool.query(
        `UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2 AND agency_id = $3`,
        [studentUpdate.status, studentId, agencyId]
      );
      console.log(`[Auto-Sync] Student ${studentId} → ${studentUpdate.status}`);
    } catch (syncErr) {
      // auto-sync ব্যর্থ হলেও pre-departure save সফল, তাই error throw করবো না
      console.error("[Auto-Sync Error]", syncErr.message);
    }
  }

  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// POST /api/pre-departure/:studentId/upload — step-এ ডকুমেন্ট আপলোড
// ═══════════════════════════════════════════════════════
router.post("/:studentId/upload", auth, pdUpload.single("file"), asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.studentId;
  const step = req.body.step; // coe, health, tuition, vfs, visa, flight + country-specific

  // Validation — step ও file দিতে হবে (সব দেশের steps include)
  const validSteps = [
    "coe", "health", "tuition", "vfs", "visa", "flight",            // Japan
    "admission", "blocked_account", "insurance",                      // Germany
    "admission_topik", "d4_visa", "arrival_arc",                      // Korea
  ];
  if (!step || !validSteps.includes(step)) {
    return res.status(400).json({ error: "সঠিক step দিন" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "ফাইল সিলেক্ট করুন" });
  }

  // ফাইল URL তৈরি
  const fileUrl = `/uploads/pre-departure/${req.file.filename}`;
  const fileEntry = {
    id: `f_${Date.now()}`,
    step,
    name: req.file.originalname,
    url: fileUrl,
    size: req.file.size,
    uploaded_at: new Date().toISOString().slice(0, 10),
  };

  // pre_departure record-এ files JSONB-তে নতুন entry যোগ
  const pool = supabase.pool;

  // pre_departure record আছে কিনা দেখো
  const { rows: existing } = await pool.query(
    `SELECT id, files FROM pre_departure WHERE student_id = $1 AND agency_id = $2`,
    [studentId, agencyId]
  );

  let updatedFiles;
  if (existing.length > 0) {
    // existing record — files array-তে append
    const currentFiles = existing[0].files || [];
    updatedFiles = [...currentFiles, fileEntry];
    await pool.query(
      `UPDATE pre_departure SET files = $1 WHERE id = $2`,
      [JSON.stringify(updatedFiles), existing[0].id]
    );
  } else {
    // নতুন record তৈরি — শুধু files সহ
    updatedFiles = [fileEntry];
    await pool.query(
      `INSERT INTO pre_departure (agency_id, student_id, files) VALUES ($1, $2, $3)`,
      [agencyId, studentId, JSON.stringify(updatedFiles)]
    );
  }

  // Cache invalidate — ফাইল আপলোড হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({ files: updatedFiles, uploaded: fileEntry });
}));

// ═══════════════════════════════════════════════════════
// GET /api/pre-departure/:studentId/files — student-এর সব আপলোড করা ফাইল
// ═══════════════════════════════════════════════════════
router.get("/:studentId/files", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.studentId;
  const pool = supabase.pool;

  const { rows } = await pool.query(
    `SELECT files FROM pre_departure WHERE student_id = $1 AND agency_id = $2`,
    [studentId, agencyId]
  );

  const files = (rows.length > 0 && rows[0].files) ? rows[0].files : [];
  res.json({ files });
}));

// ═══════════════════════════════════════════════════════
// DELETE /api/pre-departure/:studentId/files/:fileId — ফাইল মুছে ফেলা
// ═══════════════════════════════════════════════════════
router.delete("/:studentId/files/:fileId", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const studentId = req.params.studentId;
  const fileId = req.params.fileId;
  const pool = supabase.pool;

  // existing files আনো
  const { rows } = await pool.query(
    `SELECT id, files FROM pre_departure WHERE student_id = $1 AND agency_id = $2`,
    [studentId, agencyId]
  );

  if (rows.length === 0) return res.status(404).json({ error: "রেকর্ড পাওয়া যায়নি" });

  const currentFiles = rows[0].files || [];
  const fileToDelete = currentFiles.find(f => f.id === fileId);

  if (!fileToDelete) return res.status(404).json({ error: "ফাইল পাওয়া যায়নি" });

  // ডিস্ক থেকে ফাইল মুছো
  const filePath = path.join(__dirname, "../..", fileToDelete.url);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {
    console.error("[FILE DELETE]", e.message);
  }

  // JSONB থেকে entry সরাও
  const updatedFiles = currentFiles.filter(f => f.id !== fileId);
  await pool.query(
    `UPDATE pre_departure SET files = $1 WHERE id = $2`,
    [JSON.stringify(updatedFiles), rows[0].id]
  );

  // Cache invalidate — ফাইল মুছে ফেলা হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({ files: updatedFiles });
}));

module.exports = router;
