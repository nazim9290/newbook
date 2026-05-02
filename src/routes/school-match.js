/**
 * school-match.js — Smart School Matching (Phase 5 F16)
 *
 * Mounted at /api/school-match
 *
 * Given a student profile, score every agency school by fit. Live computed.
 *
 * Scoring:
 *   + JLPT level meets school's min_jp_level                +25
 *   + Country preference matches                            +20
 *   + Tuition within sponsor budget (if sponsor exists)     +15
 *   + Has dormitory (if student has no current address)     +10
 *   + Active deadline approaching (still applicable)        +10
 *   + Past placements at this school by agency              +20 max
 *
 * Routes:
 *   GET /student/:id           — top 10 schools for the student
 *   GET /student/:id/all       — all agency schools with score
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const JLPT_RANK = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };

function scoreSchoolFit(school, student, sponsor, pastPlacements) {
  const breakdown = {};
  let score = 30;

  // JLPT level
  const stuLevel = student.jp_level || student.highest_jp_level;
  const schoolMin = school.min_jp_level;
  if (stuLevel && schoolMin && JLPT_RANK[stuLevel] >= JLPT_RANK[schoolMin]) {
    breakdown.jlpt_match = 25;
    score += 25;
  } else if (!schoolMin) {
    breakdown.jlpt_no_requirement = 5;
    score += 5;
  } else {
    breakdown.jlpt_below = -10;
    score -= 10;
  }

  // Country preference
  const stuCountry = student.country;
  if (stuCountry && school.country && stuCountry.toLowerCase() === school.country.toLowerCase()) {
    breakdown.country_match = 20;
    score += 20;
  }

  // Tuition vs sponsor income (rough heuristic)
  if (sponsor && sponsor.annual_income && school.tuition_y1) {
    const incomeNum = Number(sponsor.annual_income) || 0;
    const tuition = Number(school.tuition_y1) || 0;
    if (incomeNum > 0 && tuition > 0) {
      // Affordable if tuition < 40% of annual income
      if (tuition < incomeNum * 0.4) { breakdown.affordable = 15; score += 15; }
      else if (tuition < incomeNum * 0.8) { breakdown.tight_budget = 5; score += 5; }
      else { breakdown.unaffordable = -15; score -= 15; }
    }
  }

  // Dormitory
  if (school.has_dormitory) { breakdown.has_dormitory = 10; score += 10; }

  // Deadline proximity
  const today = new Date();
  const deadlineApr = school.deadline_april ? new Date(school.deadline_april) : null;
  const deadlineOct = school.deadline_october ? new Date(school.deadline_october) : null;
  const futureDeadlines = [deadlineApr, deadlineOct].filter(d => d && d > today);
  if (futureDeadlines.length > 0) {
    const nearest = Math.min(...futureDeadlines.map(d => d - today));
    const daysAway = Math.round(nearest / (24 * 3600 * 1000));
    if (daysAway > 7 && daysAway < 90) { breakdown.deadline_open = 10; score += 10; }
    else if (daysAway >= 90) { breakdown.deadline_distant = 3; score += 3; }
    else { breakdown.deadline_close = -5; score -= 5; }
  }

  // Track record — past placements at this school
  if (pastPlacements > 5) { breakdown.proven_partnership = 20; score += 20; }
  else if (pastPlacements > 0) { breakdown.some_placements = 10; score += 10; }

  // Commission rate boost (good for agency)
  if (school.commission_rate && Number(school.commission_rate) > 0) {
    breakdown.commission_rate = Math.min(10, Math.round(Number(school.commission_rate)));
    score += breakdown.commission_rate;
  }

  score = Math.max(0, Math.min(100, score));
  let tier = "low";
  if (score >= 70) tier = "excellent";
  else if (score >= 50) tier = "good";
  else if (score >= 30) tier = "fair";

  return { score, tier, breakdown };
}

router.get("/student/:id", asyncHandler(async (req, res) => {
  const aid = req.user.agency_id;

  // Load student + sponsor + JLPT level + past placements
  const { rows: stu } = await supabase.pool.query(
    `SELECT s.*, COALESCE(
       (SELECT level FROM student_jp_exams WHERE student_id = s.id ORDER BY created_at DESC LIMIT 1),
       NULL
     ) AS highest_jp_level
     FROM students s WHERE s.id = $1 AND s.agency_id = $2`,
    [req.params.id, aid]
  );
  if (!stu.length) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  const { rows: sponsorRows } = await supabase.pool.query(
    `SELECT * FROM sponsors WHERE student_id = $1 LIMIT 1`, [req.params.id]
  );
  const sponsor = sponsorRows[0] || null;

  const { rows: schools } = await supabase.pool.query(
    `SELECT s.id, s.name_en, s.name_jp, s.country, s.city, s.tuition_y1, s.shoukai_fee,
            s.commission_rate, s.min_jp_level, s.has_dormitory, s.dormitory_fee,
            s.deadline_april, s.deadline_october,
            (SELECT COUNT(*)::int FROM students st WHERE st.school_id = s.id AND st.status IN ('VISA_GRANTED','ARRIVED','COMPLETED')) AS past_placements
     FROM schools s WHERE s.agency_id = $1`,
    [aid]
  );

  const items = schools.map((sch) => {
    const { score, tier, breakdown } = scoreSchoolFit(sch, stu[0], sponsor, sch.past_placements || 0);
    return { ...sch, score, tier, score_breakdown: breakdown };
  });
  items.sort((a, b) => b.score - a.score);

  const limit = req.query.all === "true" ? items.length : 10;
  res.json({
    student: { id: stu[0].id, name: stu[0].name_en || stu[0].name_bn, jp_level: stu[0].highest_jp_level, country: stu[0].country },
    count: items.length,
    items: items.slice(0, limit),
  });
}));

module.exports = router;
