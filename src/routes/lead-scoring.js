/**
 * lead-scoring.js — Smart Lead Scoring (Phase 5 F13)
 *
 * Mounted at /api/lead-scoring
 *
 * Computes a 0–100 conversion-likelihood score per visitor based on:
 *   + Has Japanese exam certificate         +15
 *   + Has passport                          +10
 *   + Sponsor info present                  +10
 *   + Engagement: ≥2 follow-ups in 14 days  +20
 *   + Recent visit (<7 days)                +10
 *   + Has email                             +5
 *   + Has agent referral                    +10
 *   + Status progression (FOLLOW_UP+)       +20
 *   + Budget concern flagged                -15
 *   + No follow-up >30 days                 -10
 *
 * Routes:
 *   GET /visitors           — all visitors with computed score
 *   GET /visitors/:id       — single visitor with score breakdown
 *   GET /summary            — aggregate (hot/warm/cold counts)
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const STATUS_PROGRESSION = {
  Interested: 5, "Follow-up": 15, FOLLOW_UP: 20, ENROLLED: 80,
  IN_COURSE: 90, EXAM_PASSED: 95,
};

function scoreVisitor(v) {
  const breakdown = {};
  let score = 30; // baseline

  // Positive factors
  if (v.has_jp_cert) { breakdown.has_jp_cert = +15; score += 15; }
  if (v.email && v.email.includes("@")) { breakdown.has_email = +5; score += 5; }
  if (v.agent_id) { breakdown.has_agent = +10; score += 10; }
  if (v.dob) { breakdown.has_dob = +3; score += 3; }
  if (v.address && v.address.length > 5) { breakdown.has_address = +2; score += 2; }

  // Status progression
  const statusBoost = STATUS_PROGRESSION[v.status];
  if (statusBoost !== undefined) {
    breakdown.status_boost = statusBoost;
    score += statusBoost;
  }

  // Recency
  const now = Date.now();
  if (v.visit_date) {
    const days = Math.round((now - new Date(v.visit_date).getTime()) / (24 * 3600 * 1000));
    if (days <= 7) { breakdown.recent_visit = +10; score += 10; }
    else if (days <= 30) { breakdown.recent_visit_month = +5; score += 5; }
  }

  // Engagement: follow-up cadence
  if (v.last_follow_up && v.visit_date) {
    const daysSinceFollow = Math.round((now - new Date(v.last_follow_up).getTime()) / (24 * 3600 * 1000));
    if (daysSinceFollow <= 7) { breakdown.recent_followup = +15; score += 15; }
    else if (daysSinceFollow <= 14) { breakdown.followup_2w = +10; score += 10; }
    else if (daysSinceFollow > 30) { breakdown.stale_followup = -10; score -= 10; }
  } else if (v.visit_date) {
    const days = Math.round((now - new Date(v.visit_date).getTime()) / (24 * 3600 * 1000));
    if (days > 14) { breakdown.no_followup = -15; score -= 15; }
  }

  // Negative factors
  if (v.budget_concern) { breakdown.budget_concern = -15; score -= 15; }

  // Clamp 0..100
  score = Math.max(0, Math.min(100, score));

  // Tier
  let tier = "cold";
  if (score >= 70) tier = "hot";
  else if (score >= 45) tier = "warm";

  return { score, tier, breakdown };
}

// GET /visitors — all visitors with score
router.get("/visitors", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT id, name, name_en, name_bn, phone, email, status, country, agent_id,
           visit_date, last_follow_up, next_follow_up, has_jp_cert, jp_level,
           dob, address, agent_name, budget_concern, branch
    FROM visitors
    WHERE agency_id = $1
    ORDER BY visit_date DESC NULLS LAST
    LIMIT 1000
  `, [req.user.agency_id]);

  const scored = rows.map((v) => {
    const { score, tier, breakdown } = scoreVisitor(v);
    return { ...v, score, tier, score_breakdown: breakdown };
  });
  scored.sort((a, b) => b.score - a.score);

  res.json({ count: scored.length, items: scored });
}));

router.get("/visitors/:id", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(
    `SELECT * FROM visitors WHERE id = $1 AND agency_id = $2`,
    [req.params.id, req.user.agency_id]
  );
  if (!rows.length) return res.status(404).json({ error: "Visitor পাওয়া যায়নি" });
  const v = rows[0];
  const { score, tier, breakdown } = scoreVisitor(v);
  res.json({ visitor: v, score, tier, breakdown });
}));

// GET /summary — KPI totals
router.get("/summary", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT id, status, agent_id, visit_date, last_follow_up, has_jp_cert,
           dob, address, email, budget_concern, agent_name
    FROM visitors
    WHERE agency_id = $1
  `, [req.user.agency_id]);

  let hot = 0, warm = 0, cold = 0;
  for (const v of rows) {
    const { tier } = scoreVisitor(v);
    if (tier === "hot") hot++;
    else if (tier === "warm") warm++;
    else cold++;
  }
  res.json({ total: rows.length, hot, warm, cold });
}));

module.exports = router;
