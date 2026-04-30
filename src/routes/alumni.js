/**
 * alumni.js — Alumni network routes.
 *
 * Two layers:
 *   1. Snapshot fields on students (alumni_*) — updated via PATCH /api/students/:id (existing)
 *   2. Time-series timeline (alumni_updates table) — full CRUD here
 *
 * Routes:
 *   GET    /api/alumni                     — list students with alumni view (filters: status, city, year)
 *   GET    /api/alumni/:studentId/updates  — timeline for one student (newest first)
 *   POST   /api/alumni/:studentId/updates  — add a new timeline entry
 *   PATCH  /api/alumni/updates/:id         — edit a timeline entry
 *   DELETE /api/alumni/updates/:id         — delete a timeline entry
 *
 * All routes are agency-scoped (req.user.agency_id) and require auth.
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { checkPermission } = require("../middleware/checkPermission");
const { decryptMany } = require("../lib/crypto");
const cache = require("../lib/cache");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
router.use(auth);

const VALID_UPDATE_TYPES = new Set([
  "status_change", "school_change", "company_change",
  "contact", "note", "photo", "referral", "other",
]);

// ════════════════════════════════════════════════════════════
// GET /api/alumni
//   Returns students whose status reached ARRIVED or COMPLETED OR who have any
//   alumni_* data set. Filters via query params:
//     ?current_status=employed
//     ?city=Tokyo
//     ?arrived_year=2024     (alumni_arrived_date YEAR match)
//     ?search=name
// ════════════════════════════════════════════════════════════
router.get("/", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { current_status, city, arrived_year, search } = req.query;

  // Use raw SQL — supabase-js .or() with .in.(A,B,C) inside breaks the comma parser
  // and silently returns ALL agency students (the bug fix this commit addresses).
  const conds = ["agency_id = $1"];
  const params = [req.user.agency_id];
  conds.push("(status IN ('VISA_GRANTED','ARRIVED','COMPLETED') OR alumni_current_status IS NOT NULL)");

  if (current_status) { params.push(current_status); conds.push(`alumni_current_status = $${params.length}`); }
  if (city)           { params.push(city);           conds.push(`alumni_city = $${params.length}`); }
  if (search)         { params.push(`%${search}%`);  conds.push(`name_en ILIKE $${params.length}`); }
  if (arrived_year) {
    params.push(`${arrived_year}-01-01`);
    conds.push(`alumni_arrived_date >= $${params.length}::date`);
    params.push(`${arrived_year}-12-31`);
    conds.push(`alumni_arrived_date <= $${params.length}::date`);
  }

  const sql = `
    SELECT id, name_en, name_bn, photo_url, status, school, school_id, batch, batch_id, branch, agent_id,
           country, source, intake,
           alumni_current_status, alumni_school_name, alumni_company_name, alumni_company_position,
           alumni_city, alumni_prefecture, alumni_last_contact, alumni_referrals_count,
           alumni_arrived_date, alumni_notes, updated_at
    FROM students
    WHERE ${conds.join(" AND ")}
    ORDER BY alumni_last_contact DESC NULLS LAST, updated_at DESC
  `;

  try {
    const { rows } = await supabase.pool.query(sql, params);
    // alumni_* columns aren't in SENSITIVE_FIELDS, but decryptMany is a no-op for plain rows
    // and gives forward-compat if any field becomes encrypted later.
    res.json(decryptMany(rows));
  } catch (err) {
    console.error("[Alumni list]", err.message);
    return res.status(500).json({ error: "Alumni লোড ব্যর্থ" });
  }
}));

// ════════════════════════════════════════════════════════════
// GET /api/alumni/stats — summary counts for dashboard cards
// ════════════════════════════════════════════════════════════
router.get("/stats", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const pool = supabase.pool;
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('VISA_GRANTED','ARRIVED','COMPLETED') OR alumni_current_status IS NOT NULL)::int AS total_alumni,
      COUNT(*) FILTER (WHERE alumni_current_status = 'language_school')::int AS language_school,
      COUNT(*) FILTER (WHERE alumni_current_status = 'senmon')::int          AS senmon,
      COUNT(*) FILTER (WHERE alumni_current_status = 'university')::int      AS university,
      COUNT(*) FILTER (WHERE alumni_current_status = 'employed')::int        AS employed,
      COUNT(*) FILTER (WHERE alumni_current_status = 'returned')::int        AS returned,
      COALESCE(SUM(alumni_referrals_count), 0)::int                          AS total_referrals
    FROM students WHERE agency_id = $1
  `, [req.user.agency_id]);
  res.json(rows[0] || {});
}));

// ════════════════════════════════════════════════════════════
// GET /api/alumni/:studentId/updates — timeline for one student
// ════════════════════════════════════════════════════════════
router.get("/:studentId/updates", checkPermission("students", "read"), asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  // Verify student belongs to agency
  const { data: stu } = await supabase.from("students").select("id").eq("id", studentId).eq("agency_id", req.user.agency_id).single();
  if (!stu) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const { data, error } = await supabase.from("alumni_updates")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .eq("student_id", studentId)
    .order("update_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) { console.error("[Alumni updates list]", error.message); return res.status(500).json({ error: "Timeline লোড ব্যর্থ" }); }
  res.json(data || []);
}));

// ════════════════════════════════════════════════════════════
// POST /api/alumni/:studentId/updates — add a timeline entry
// Body: { update_type, title, content, update_date, attachments }
// ════════════════════════════════════════════════════════════
router.post("/:studentId/updates", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { update_type, title, content, update_date, attachments } = req.body || {};
  if (!update_type || !VALID_UPDATE_TYPES.has(update_type)) {
    return res.status(400).json({ error: "update_type অবৈধ" });
  }
  // Verify student belongs to agency
  const { data: stu } = await supabase.from("students").select("id, name_en").eq("id", studentId).eq("agency_id", req.user.agency_id).single();
  if (!stu) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const { data, error } = await supabase.from("alumni_updates").insert({
    agency_id:   req.user.agency_id,
    student_id:  studentId,
    update_type,
    title:       title || null,
    content:     content || null,
    update_date: update_date || null,    // null → DB default = today
    attachments: attachments && Array.isArray(attachments) ? JSON.stringify(attachments) : "[]",
    created_by:  req.user.id,
  }).select().single();
  if (error) { console.error("[Alumni update create]", error.message); return res.status(400).json({ error: "Save ব্যর্থ" }); }

  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id,
    action: "create", module: "alumni", recordId: data.id,
    description: `Alumni update: ${stu.name_en} — ${update_type}`,
    ip: req.ip,
  }).catch(() => {});
  cache.invalidate(req.user.agency_id);

  res.json(data);
}));

// ════════════════════════════════════════════════════════════
// PATCH /api/alumni/updates/:id — edit a timeline entry
// ════════════════════════════════════════════════════════════
router.patch("/updates/:id", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const updates = {};
  ["update_type", "title", "content", "update_date"].forEach(k => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });
  if (req.body.attachments !== undefined) {
    updates.attachments = Array.isArray(req.body.attachments) ? JSON.stringify(req.body.attachments) : "[]";
  }
  if (updates.update_type && !VALID_UPDATE_TYPES.has(updates.update_type)) {
    return res.status(400).json({ error: "update_type অবৈধ" });
  }
  if (updates.update_date === "") updates.update_date = null;

  const { data, error } = await supabase.from("alumni_updates")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select().single();
  if (error || !data) return res.status(400).json({ error: "Update ব্যর্থ" });

  cache.invalidate(req.user.agency_id);
  res.json(data);
}));

// ════════════════════════════════════════════════════════════
// DELETE /api/alumni/updates/:id
// ════════════════════════════════════════════════════════════
router.delete("/updates/:id", checkPermission("students", "delete"), asyncHandler(async (req, res) => {
  const { error } = await supabase.from("alumni_updates")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "Delete ব্যর্থ" });
  cache.invalidate(req.user.agency_id);
  res.json({ success: true });
}));

module.exports = router;
