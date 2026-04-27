/**
 * ai-portal.js — Student Portal access + AI Purpose of Study generation
 *
 * POST /:id/portal-access            — Admin portal access on/off + password set
 * POST /:id/generate-study-purpose   — Claude Haiku দিয়ে "Purpose of Study" letter
 *                                      (5 credit/generation, save to student record)
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const { logActivity } = require("../../lib/activityLog");

const router = express.Router();
router.use(auth);

// ================================================================
// POST /api/students/:id/portal-access — Admin portal access on/off + password set
// ================================================================
router.post("/:id/portal-access", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const { enabled, password } = req.body;
  const updates = { portal_access: !!enabled };

  // Enable করলে এবং password দিলে hash করে সেট করো
  if (enabled && password) {
    updates.portal_password_hash = await bcrypt.hash(password, 12);
  }

  const { data, error } = await supabase.from("students").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select("id, name_en, portal_access").single();
  if (error) return res.status(500).json({ error: "আপডেট ব্যর্থ" });
  res.json(data);
}));

// ═══════════════════════════════════════════════════════
// POST /api/students/:id/generate-study-purpose
// AI দিয়ে "Purpose of Study" letter generate করে student record-এ save
// প্রথমবার generate → save → পরবর্তীতে saved data ব্যবহার হবে
// ═══════════════════════════════════════════════════════
router.post("/:id/generate-study-purpose", checkPermission("students", "write"), asyncHandler(async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "AI API key configured নেই" });

  // ── Credit check — প্রতি generation-এ 5 credit লাগে ──
  const AI_CREDITS = 5;
  const { data: agencyCredits } = await supabase.from("agencies").select("ocr_credits").eq("id", req.user.agency_id).single();
  const balance = agencyCredits?.ocr_credits || 0;
  if (balance < AI_CREDITS) {
    return res.status(402).json({
      error: `AI credit অপর্যাপ্ত (${balance}/${AI_CREDITS})`,
      code: "NO_CREDITS", credits: balance, required: AI_CREDITS,
    });
  }

  // ── Student data আনো — AI prompt-এ ব্যবহার হবে ──
  const { data: student } = await supabase
    .from("students")
    .select("*")
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .single();
  if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

  // ── JP Exam data আনো ──
  const { data: jpExams } = await supabase
    .from("student_jp_exams")
    .select("exam_type, level, score, result")
    .eq("student_id", req.params.id);

  // ── JP Study history আনো ──
  const { data: jpStudy } = await supabase
    .from("student_jp_study")
    .select("institution, hours")
    .eq("student_id", req.params.id);

  // ── Education আনো ──
  const { data: education } = await supabase
    .from("student_education")
    .select("level, school_name, year, gpa, group_name")
    .eq("student_id", req.params.id);

  // ── School info ──
  let schoolName = student.school || "";
  let schoolCity = "";
  if (student.school_id) {
    const { data: school } = await supabase.from("schools").select("name_en, city").eq("id", student.school_id).single();
    if (school) { schoolName = school.name_en || schoolName; schoolCity = school.city || ""; }
  }

  // ── Agency info আনো — current institution হিসেবে agency name ব্যবহার হবে ──
  const { data: agency } = await supabase.from("agencies").select("name, settings").eq("id", req.user.agency_id).single();
  const agencyName = agency?.name || "";
  const customPrompt = agency?.settings?.study_purpose_prompt || "";

  // ── Validation — required fields check (force=true হলে skip) ──
  const force = req.body?.force === true;
  const missing = [];
  if (!student.name_en) missing.push("Full Name (Profile → Personal Info)");
  if (!student.dob) missing.push("Date of Birth (Profile → Personal Info)");
  if (!(education || []).length) missing.push("Education — SSC/HSC (Profile → Education → Add)");
  if (!schoolName) missing.push("Japanese School (Profile → Destination Info → School)");

  if (missing.length > 0 && !force) {
    return res.status(400).json({
      error: "Purpose of Study generate করতে নিচের তথ্যগুলো আগে পূরণ করুন",
      code: "MISSING_FIELDS",
      missing_fields: missing,
    });
  }

  // ── Student context — AI-কে student-এর সব data দেওয়া হচ্ছে ──
  const age = student.dob ? Math.floor((Date.now() - new Date(student.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : "";
  const jpExamInfo = (jpExams || []).map(e => `${e.exam_type} ${e.level} (${e.result})`).join(", ") || "None";
  // JP Study — record থাকলে সেটা, না থাকলে agency-ই default training provider (180 hours)
  const hasJpStudy = (jpStudy || []).length > 0;
  const jpStudyInfo = hasJpStudy
    ? (jpStudy || []).map(s => `${s.institution} (${s.hours || "?"} hours)`).join(", ")
    : `${agencyName} (180 hours)`;
  const totalJpHours = hasJpStudy
    ? (jpStudy || []).reduce((sum, s) => sum + (parseInt(s.hours) || 0), 0)
    : 180;

  // ── Education sorting — সর্বশেষ শিক্ষা আগে, subject/group সহ ──
  const eduLevels = { "Masters": 6, "Bachelor": 5, "Degree": 5, "Honours": 5, "Diploma": 4, "HSC": 3, "Alim": 3, "SSC": 2, "Dakhil": 2, "Other": 1 };
  const sortedEdu = (education || []).sort((a, b) => (eduLevels[b.level] || 0) - (eduLevels[a.level] || 0));
  const lastEdu = sortedEdu[0] || {};
  const eduInfo = sortedEdu.map(e => `${e.level}: ${e.school_name || ""} (Year: ${e.year || "?"}, GPA: ${e.gpa || "?"}, Subject: ${e.group_name || "General"})`).join("; ");

  const studentContext = `
Student Information:
- Full Name: ${student.name_en}
- Age: ${age} years old
- Gender: ${student.gender || "Male"}
- Country of Birth: ${student.nationality || "Bangladesh"}
- Last Education Level: ${lastEdu.level || "HSC"} (${lastEdu.group_name || "General"})
- Last Education Institution: ${lastEdu.school_name || ""}
- Education Subject/Group: ${lastEdu.group_name || "General"}
- Full Education History: ${eduInfo}
- Current Institution (Agency/Academy): ${agencyName}
- Study Subject in Japan: ${student.study_subject || "Japanese Language"}
- Japanese Language Exams: ${jpExamInfo}
- Japanese Study History: ${jpStudyInfo}
- Total Japanese Training Hours: ${totalJpHours || "150+"}
- Daily Self-Study Hours: 2 hours
- Japanese School in Japan: ${schoolName}${schoolCity ? ` (${schoolCity}, Japan)` : ""}
- Target Country: Japan
- Visa Type: ${student.visa_type || "Language Student"}
`;

  // ── Default system prompt — agency customize না করলে এটা ব্যবহার হবে ──
  const defaultPrompt = `You are a professional academic writer specializing in Japanese student visa applications.

Your ONLY task is to write a "Purpose of Study" letter.

You MUST always write EXACTLY 6 paragraphs in this fixed order:

PARAGRAPH 1 — Self Introduction
Write about: full name, age, country of birth, completed exams/degrees, current institution and subject, and future academic goal.

PARAGRAPH 2 — Purpose of Studying [Subject]
Write about: why the student chose this specific subject, what skills and knowledge it provides, career opportunities (employment + entrepreneurship), and salary/professional value.

PARAGRAPH 3 — Reasons for Choosing Japan
Write about: Japan's excellence in this field, international value of a Japanese degree, part-time work opportunities, internal scholarship availability, JLPT and job market connection, and Japan's economic strength (3rd largest economy).

PARAGRAPH 4 — Japanese Language Preparation
Write about: which JLPT level completed, name of language academy, total training hours, and daily self-study practice hours.

PARAGRAPH 5 — School Admission & Expectation
Write about: name of the Japanese language school, its location/city, quality of teachers, and the student's hope and belief that this school will support their academic dream.

PARAGRAPH 6 — Future Plan & Commitment
Write about: commitment to disciplined and hardworking life in Japan, plan to excel academically, intention to work at a Japanese company after graduation, and long-term settlement plan in Japan.

STRICT RULES:
- Always write exactly 6 paragraphs — no more, no less
- No bullet points — flowing prose only
- No subject line, no greeting (do not write "Dear Sir/Madam")
- Formal, sincere, and natural tone
- Each paragraph must be self-contained and focused on its designated topic only
- Do not mix topics between paragraphs
- Word count: STRICTLY 300–350 words total — MUST fit in ONE page
- Each paragraph should be 3-5 sentences MAXIMUM — keep it concise
- Separate each paragraph with a blank line

HUMANIZE — CRITICAL:
- Write like a real Bangladeshi student wrote it, NOT like AI generated
- Use simple, natural English — avoid complex vocabulary and flowery language
- Vary sentence lengths — mix short and long sentences naturally
- Avoid overused AI phrases: "furthermore", "moreover", "in addition", "it is worth noting", "I am writing to express", "embark on a journey", "pursue my passion", "hone my skills"
- Avoid starting multiple sentences with "I" — vary sentence structure
- Include small personal touches that feel genuine (e.g., "My father encouraged me", "I first became interested when...")
- Use contractions occasionally (I've, I'm, it's) to sound natural
- Keep it slightly imperfect — a real student letter is not perfectly polished
- Sound motivated but not dramatic — no "burning desire" or "lifelong dream"
- Each paragraph should flow naturally into the next, like a real person telling their story
- The overall tone should feel like a sincere, thoughtful student — not a marketing brochure`;

  const systemPrompt = customPrompt || defaultPrompt;

  try {
    // ── Claude Haiku API call — Purpose of Study generate ──
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `${systemPrompt}\n\n${studentContext}\n\nWrite the Purpose of Study letter now. Return ONLY the letter text, nothing else.`
        }],
      }),
    });

    if (!response.ok) {
      console.error("[AI] Study purpose generation failed:", response.status);
      return res.status(502).json({ error: "AI generation ব্যর্থ" });
    }

    const result = await response.json();
    const purposeText = result.content?.[0]?.text || "";

    if (!purposeText.trim()) return res.status(500).json({ error: "AI empty response" });

    // ── Student record-এ save — পরবর্তীতে আর AI call লাগবে না ──
    await supabase.from("students")
      .update({
        reason_for_study: purposeText,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("agency_id", req.user.agency_id);

    // ── Credit deduct (5 credits) — generation সফল হলেই কাটবে ──
    const { pool } = supabase;
    try {
      await pool.query("UPDATE agencies SET ocr_credits = GREATEST(0, ocr_credits - $1) WHERE id = $2", [AI_CREDITS, req.user.agency_id]);
      // Usage log
      await supabase.from("ocr_usage").insert({
        agency_id: req.user.agency_id, user_id: req.user.id,
        doc_type: "purpose_of_study", engine: "haiku",
        credits_used: AI_CREDITS, confidence: "high",
        fields_extracted: 1, file_name: student.name_en || "",
      });
      // Credit transaction log
      const newBalance = balance - AI_CREDITS;
      await supabase.from("ocr_credit_log").insert({
        agency_id: req.user.agency_id, amount: -AI_CREDITS, balance_after: newBalance,
        type: "ai_generate", description: `Purpose of Study: ${student.name_en}`,
        created_by: req.user.id,
      });
    } catch (e) { console.error("[Credit Deduct]", e.message); }

    // Activity log
    logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "students",
      recordId: req.params.id, description: `AI Purpose of Study generated: ${student.name_en}`, ip: req.ip }).catch(() => {});

    res.json({
      success: true,
      reason_for_study: purposeText,
      word_count: purposeText.split(/\s+/).length,
      credits_used: AI_CREDITS,
      credits_remaining: Math.max(0, balance - AI_CREDITS),
    });

  } catch (err) {
    console.error("[AI Error]", err.message);
    res.status(500).json({ error: "AI generation failed: " + err.message });
  }
}));

module.exports = router;
