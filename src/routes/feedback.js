/**
 * feedback.js — NPS / student review system (Phase 3 Feature 10)
 *
 * Mounted at /api/feedback
 *
 * Routes:
 *   POST   /public/:token       — UNAUTH — student submits via emailed link
 *   GET    /public/:token       — UNAUTH — fetch survey context (student name etc.)
 *   GET    /                    — owner: paginated survey list with filter
 *   PATCH  /:id                 — owner: toggle is_public
 *   POST   /invite/:studentId   — owner: manually issue an invite (token + email)
 *   GET    /testimonials        — UNAUTH — public-approved reviews (widget endpoint)
 *   GET    /stats               — owner: NPS score + distribution
 */

const express = require("express");
const crypto = require("crypto");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { notify } = require("../lib/notify");

const router = express.Router();

const OWNER_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

function genToken() {
  return crypto.randomBytes(24).toString("base64url");
}

// ════════════════════════════════════════════════════════════
// PUBLIC endpoints — UNAUTH (token-based)
// ════════════════════════════════════════════════════════════

// GET /public/:token — load survey context
router.get("/public/:token", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT f.id, f.student_id, f.trigger_event, f.language, f.link_expires_at, f.submitted_at,
           s.name_en, s.name_bn, sch.name_en AS school_name
    FROM feedback_surveys f
    LEFT JOIN students s ON s.id = f.student_id
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE f.link_token = $1 LIMIT 1
  `, [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: "Invalid link" });
  const f = rows[0];
  if (f.submitted_at) return res.status(410).json({ error: "Already submitted" });
  if (f.link_expires_at && new Date(f.link_expires_at) < new Date()) {
    return res.status(410).json({ error: "Link expired" });
  }
  res.json({
    id: f.id,
    student_name: f.name_en || f.name_bn,
    school_name: f.school_name,
    trigger_event: f.trigger_event,
    language: f.language || "bn",
  });
}));

// POST /public/:token — submit
router.post("/public/:token", asyncHandler(async (req, res) => {
  const { nps_score, rating, text_review, consent_given } = req.body || {};
  if (nps_score !== undefined && (nps_score < 0 || nps_score > 10)) {
    return res.status(400).json({ error: "NPS 0-10 হতে হবে" });
  }
  if (rating !== undefined && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: "Rating 1-5 হতে হবে" });
  }

  const { rows } = await supabase.pool.query(`
    SELECT id, submitted_at, link_expires_at FROM feedback_surveys
    WHERE link_token = $1 LIMIT 1
  `, [req.params.token]);
  if (!rows.length) return res.status(404).json({ error: "Invalid link" });
  const f = rows[0];
  if (f.submitted_at) return res.status(410).json({ error: "Already submitted" });
  if (f.link_expires_at && new Date(f.link_expires_at) < new Date()) {
    return res.status(410).json({ error: "Link expired" });
  }

  await supabase.pool.query(`
    UPDATE feedback_surveys
    SET nps_score = $1, rating = $2, text_review = $3, consent_given = $4, submitted_at = NOW()
    WHERE id = $5
  `, [nps_score ?? null, rating ?? null, text_review ?? null, !!consent_given, f.id]);

  res.json({ ok: true, message: "ধন্যবাদ! আপনার মতামত পেয়েছি।" });
}));

// GET /testimonials — public widget endpoint (with agency_id query param)
router.get("/testimonials", asyncHandler(async (req, res) => {
  const agencyId = req.query.agency_id;
  if (!agencyId) return res.status(400).json({ error: "agency_id দিন" });

  const { rows } = await supabase.pool.query(`
    SELECT f.id, f.rating, f.nps_score, f.text_review, f.submitted_at,
           s.name_en AS student_name, sch.name_en AS school_name
    FROM feedback_surveys f
    LEFT JOIN students s ON s.id = f.student_id
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE f.agency_id = $1
      AND f.is_public = TRUE
      AND f.consent_given = TRUE
      AND f.text_review IS NOT NULL
      AND LENGTH(f.text_review) > 0
    ORDER BY f.submitted_at DESC NULLS LAST
    LIMIT 50
  `, [agencyId]);
  res.json({ count: rows.length, items: rows });
}));

// ════════════════════════════════════════════════════════════
// AUTH endpoints — owner only
// ════════════════════════════════════════════════════════════
router.use(auth);

// GET / — paginated list
router.get("/", requireOwner, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const offset = (page - 1) * limit;
  const where = ["f.agency_id = $1"];
  const params = [req.user.agency_id];
  if (req.query.submitted === "true") where.push(`f.submitted_at IS NOT NULL`);
  if (req.query.submitted === "false") where.push(`f.submitted_at IS NULL`);
  if (req.query.public === "true") where.push(`f.is_public = TRUE`);
  params.push(limit); params.push(offset);

  const { rows } = await supabase.pool.query(`
    SELECT f.*, s.name_en, s.name_bn, sch.name_en AS school_name
    FROM feedback_surveys f
    LEFT JOIN students s ON s.id = f.student_id
    LEFT JOIN schools sch ON sch.id = s.school_id
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(f.submitted_at, f.invitation_sent_at) DESC NULLS LAST
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  res.json({ page, limit, items: rows });
}));

// PATCH /:id — toggle is_public
router.patch("/:id", requireOwner, asyncHandler(async (req, res) => {
  const allowed = ["is_public"];
  const updates = {};
  for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid field" });
  const setParts = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(", ");
  const params = [...Object.values(updates), req.params.id, req.user.agency_id];
  const { rows } = await supabase.pool.query(
    `UPDATE feedback_surveys SET ${setParts} WHERE id = $${Object.keys(updates).length + 1} AND agency_id = $${Object.keys(updates).length + 2} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
}));

// POST /invite/:studentId — manually issue an invite
router.post("/invite/:studentId", requireOwner, asyncHandler(async (req, res) => {
  const { trigger_event = "manual", language = "bn" } = req.body || {};
  const { rows: stu } = await supabase.pool.query(
    `SELECT id, name_en, name_bn, email, phone FROM students WHERE id = $1 AND agency_id = $2 LIMIT 1`,
    [req.params.studentId, req.user.agency_id]
  );
  if (!stu.length) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const token = genToken();
  const expires = new Date(); expires.setDate(expires.getDate() + 30);
  const { rows: created } = await supabase.pool.query(`
    INSERT INTO feedback_surveys (agency_id, student_id, trigger_event, language, link_token, link_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, link_token
  `, [req.user.agency_id, stu[0].id, trigger_event, language, token, expires.toISOString()]);

  // Try to send invitation email (best effort — students may not have email)
  if (stu[0].email) {
    try {
      await notify({
        agencyId: req.user.agency_id,
        channel: "email",
        to: [{ email: stu[0].email, name: stu[0].name_en || stu[0].name_bn || "" }],
        template: "anomaly_alert", // reusing — TODO: add proper feedback_invite template
        data: {
          ruleType: "feedback_invite",
          actorName: stu[0].name_en,
          details: { token, link: `https://demo.agencybook.net/feedback/${token}` },
          agencyName: "AgencyOS",
        },
      });
    } catch (e) {
      console.error("[feedback invite] email failed:", e.message);
    }
  }

  res.json({
    ok: true,
    feedback_id: created[0].id,
    token: created[0].link_token,
    link: `${req.protocol}://${req.get("host").replace(/-api/, "")}/feedback/${created[0].link_token}`,
  });
}));

// GET /stats — NPS score + distribution
router.get("/stats", requireOwner, asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS responses,
      COUNT(*) FILTER (WHERE submitted_at IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE nps_score >= 9)::int AS promoters,
      COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8)::int AS passives,
      COUNT(*) FILTER (WHERE nps_score <= 6 AND nps_score IS NOT NULL)::int AS detractors,
      AVG(rating)::float AS avg_rating
    FROM feedback_surveys
    WHERE agency_id = $1 AND submitted_at IS NOT NULL
  `, [req.user.agency_id]);
  const r = rows[0];
  const totalNps = (r.promoters || 0) + (r.passives || 0) + (r.detractors || 0);
  const npsScore = totalNps > 0 ? Math.round(((r.promoters - r.detractors) / totalNps) * 100) : null;
  res.json({
    responses: r.responses, pending: r.pending,
    promoters: r.promoters, passives: r.passives, detractors: r.detractors,
    avg_rating: r.avg_rating ? Math.round(r.avg_rating * 10) / 10 : null,
    nps_score: npsScore,
  });
}));

module.exports = router;
