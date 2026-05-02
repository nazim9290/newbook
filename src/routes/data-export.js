/**
 * data-export.js — GDPR-style per-record data export (Phase 6 F14)
 *
 * Mounted at /api/data-export
 *
 * Routes:
 *   GET /student/:id      — full JSON dump of a single student + related records
 *   GET /agency           — owner-only: full agency data dump (all entities)
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { decryptMany, decryptSensitiveFields } = require("../lib/crypto");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

// GET /student/:id — single student full dump
router.get("/student/:id", requireOwner, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const aid = req.user.agency_id;

  const { rows: stu } = await supabase.pool.query(
    `SELECT * FROM students WHERE id = $1 AND agency_id = $2`, [id, aid]
  );
  if (!stu.length) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const collect = async (table, idCol = "student_id") => {
    try {
      const { rows } = await supabase.pool.query(
        `SELECT * FROM "${table}" WHERE ${idCol} = $1`, [id]
      );
      return rows;
    } catch { return []; }
  };

  // PII-bearing tables are decrypted before export — recipients (owner/admin)
  // need plaintext for backup/portability, never encrypted ciphertext.
  const dump = {
    exported_at: new Date().toISOString(),
    exported_by: { user_id: req.user.id, email: req.user.email },
    student: decryptSensitiveFields(stu[0]),
    education: await collect("student_education"),
    family: decryptMany(await collect("student_family")),
    jp_exams: await collect("student_jp_exams"),
    jp_study: decryptMany(await collect("student_jp_study")),
    work_experience: decryptMany(await collect("student_work_experience")),
    sponsors: decryptMany(await collect("sponsors")),
    payments: await collect("payments"),
    fee_items: await collect("fee_items"),
    documents: await collect("documents"),
    document_data: await collect("document_data"),
    pre_departure: await collect("pre_departure"),
    attendance: await collect("attendance"),
    communications: await collect("communications"),
    tasks: await collect("tasks"),
    feedback_surveys: await collect("feedback_surveys"),
  };

  const filename = `student_${id}_export_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(JSON.stringify(dump, null, 2));
}));

// GET /agency — entire agency dump (owner only)
router.get("/agency", requireOwner, asyncHandler(async (req, res) => {
  const aid = req.user.agency_id;
  const tables = [
    "agencies", "users", "agents", "branches", "sessions",
    "schools", "batches", "batch_students",
    "students", "visitors",
    "student_education", "student_jp_exams", "student_family",
    "student_jp_study", "student_work_experience",
    "sponsors", "sponsor_banks",
    "documents", "document_data", "doc_types",
    "payments", "fee_items", "expenses",
    "employees", "salary_history", "leaves",
    "tasks", "communications", "calendar_events",
    "inventory", "submissions", "pre_departure",
    "feedback_surveys", "anomaly_events", "expiry_alerts_sent",
    "activity_log",
  ];

  const dump = {
    exported_at: new Date().toISOString(),
    exported_by: { user_id: req.user.id, email: req.user.email },
    agency_id: aid,
    tables: {},
  };

  for (const tbl of tables) {
    try {
      // Handle agencies / users which may have id-based filter
      let q;
      if (tbl === "agencies") {
        q = `SELECT * FROM "agencies" WHERE id = $1`;
      } else {
        q = `SELECT * FROM "${tbl}" WHERE agency_id = $1 LIMIT 50000`;
      }
      const { rows } = await supabase.pool.query(q, [aid]);
      // Decrypt PII-bearing tables. decryptMany is a no-op for tables without
      // SENSITIVE_FIELDS columns, so blanket-applying is safe + future-proof.
      dump.tables[tbl] = decryptMany(rows);
    } catch (err) {
      dump.tables[tbl] = { error: err.message };
    }
  }

  const filename = `agency_${aid}_export_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(JSON.stringify(dump, null, 2));
}));

module.exports = router;
