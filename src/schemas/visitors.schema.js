/**
 * visitors.schema.js — Zod schemas for /api/visitors
 *
 * Field names mirror src/routes/visitors.js VALID_COLS + accepted frontend aliases.
 * Sensitive fields (phone/email/etc) match the validators in CLAUDE.md spec.
 */

const { z } = require("zod");

// ── Reusable primitives ──
const phoneBD = z
  .string()
  .trim()
  .regex(/^(\+?88)?01[3-9]\d{8}$/, "ভুল ফোন নম্বর");

const emailField = z.string().trim().toLowerCase().email("সঠিক email দিন");

const dateString = z
  .string()
  .datetime()
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "তারিখ YYYY-MM-DD ফরম্যাটে দিন"));

// Status enum — mirrors values used by routes/visitors.js + frontend (loose, additive).
const visitorStatus = z.enum([
  "Interested",
  "Following Up",
  "Lost",
  "Converted",
  "On Hold",
  "Pending",
]);

const sourceEnum = z.enum([
  "Walk-in",
  "Online",
  "Referral",
  "Agent",
  "Facebook",
  "Google",
  "Other",
]);

// ── Base shape (kept as a ZodObject so .partial() / .extend() work) ──
const visitorBase = z.object({
  // Name — at least one of name / name_en / name_bn is required (refined below in create).
  name: z.string().trim().min(1).max(200).optional(),
  name_en: z.string().trim().min(1).max(200).optional(),
  name_bn: z.string().trim().min(1).max(200).optional(),

  phone: phoneBD,
  guardian_phone: phoneBD.optional().nullable(),
  email: emailField.optional().nullable(),

  dob: dateString.optional().nullable(),
  gender: z.enum(["Male", "Female", "Other"]).optional().nullable(),
  address: z.string().max(500).optional().nullable(),

  education: z.array(z.any()).optional(),

  has_jp_cert: z.boolean().optional(),
  jp_exam_type: z.string().max(50).optional().nullable(),
  jp_level: z.string().max(50).optional().nullable(),
  jp_score: z.string().max(50).optional().nullable(),

  visa_type: z.string().max(50).optional().nullable(),
  interested_countries: z
    .array(z.string())
    .or(z.string())
    .optional(),
  interested_intake: z.string().max(50).optional().nullable(),

  budget_concern: z.boolean().optional(),
  source: sourceEnum.optional(),
  referral_info: z.string().max(500).optional().nullable(),
  agent_id: z.string().uuid().optional().nullable(),
  counselor: z.string().max(200).optional().nullable(),
  branch: z.string().max(100).optional(),

  status: visitorStatus.optional(),
  notes: z.string().max(2000).optional().nullable(),

  next_follow_up: dateString.optional().nullable(),
  visit_date: dateString.optional(),
  date: dateString.optional(), // frontend alias
});

// POST /api/visitors — create (require name + valid phone)
const createVisitorSchema = visitorBase.refine(
  (v) => Boolean(v.name || v.name_en || v.name_bn),
  { message: "নাম দিন", path: ["name"] }
);

// PATCH /api/visitors/:id — every field optional + optimistic-lock + camelCase aliases.
// Passthrough because the route already whitelists via VALID_COLS.
const updateVisitorSchema = visitorBase
  .partial()
  .extend({
    updated_at: z.string().datetime().optional(),
    lastFollowUp: dateString.optional().nullable(),
    nextFollowUp: dateString.optional().nullable(),
    visitDate: dateString.optional(),
    guardianPhone: phoneBD.optional().nullable(),
    hasJpCert: z.boolean().optional(),
    jpExamType: z.string().optional().nullable(),
    jpLevel: z.string().optional().nullable(),
    jpScore: z.string().optional().nullable(),
    interestedCountries: z.array(z.string()).or(z.string()).optional(),
    interestedIntake: z.string().optional().nullable(),
    budgetConcern: z.boolean().optional(),
    referralInfo: z.string().optional().nullable(),
    agentName: z.string().optional().nullable(),
    createdBy: z.string().optional().nullable(),
  })
  .passthrough();

// GET /api/visitors — list query params
const listVisitorsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    search: z.string().max(200).optional(),
    status: z.string().max(50).optional(),
    status_in: z.string().max(200).optional(),
    exclude_status: z.string().max(200).optional(),
    branch: z.string().max(100).optional(),
    interested_intake: z.string().max(50).optional(),
    agent_id: z.string().uuid().optional(),
  })
  .passthrough();

module.exports = {
  createVisitorSchema,
  updateVisitorSchema,
  listVisitorsQuerySchema,
};
