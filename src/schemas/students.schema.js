/**
 * students.schema.js — Zod schemas for /api/students
 *
 * Mirrors STUDENT_COLUMNS in src/routes/students/_shared.js plus accepted frontend aliases.
 */

const { z } = require("zod");

// ── Reusable primitives ──
const phoneBD = z
  .string()
  .trim()
  .regex(/^(\+?88)?01[3-9]\d{8}$/, "ভুল ফোন নম্বর");

const emailField = z.string().trim().toLowerCase().email("সঠিক email দিন");

const nidField = z
  .string()
  .trim()
  .regex(/^\d{10}$|^\d{13}$|^\d{17}$/, "NID 10/13/17 সংখ্যার হবে");

const passportField = z
  .string()
  .trim()
  .regex(/^[A-Z]{1,2}\d{6,9}$/i, "ভুল পাসপোর্ট নম্বর");

const dateString = z
  .string()
  .datetime()
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "তারিখ YYYY-MM-DD ফরম্যাটে দিন"));

const studentStatus = z.enum([
  "Active",
  "Pending",
  "Visa Applied",
  "Visa Approved",
  "Visa Rejected",
  "Departed",
  "Dropped",
  "Alumni",
]);

const countryEnum = z.enum(["Japan", "Germany", "Korea", "Other"]);

// ── Base shape (kept as a plain ZodObject so .partial() works cleanly) ──
const studentBase = z.object({
  id: z.string().max(50).optional(), // optional override; otherwise auto-generated
  name_en: z.string().trim().min(1, "নাম দিন").max(200),
  name_bn: z.string().trim().max(200).optional().nullable(),
  name_katakana: z.string().trim().max(200).optional().nullable(),

  phone: phoneBD,
  whatsapp: phoneBD.optional().nullable(),
  email: emailField.optional().nullable(),

  dob: dateString.optional().nullable(),
  gender: z.enum(["Male", "Female", "Other"]).optional().nullable(),
  marital_status: z.enum(["Single", "Married", "Divorced", "Widowed"]).optional().nullable(),
  nationality: z.string().max(100).optional().nullable(),
  blood_group: z.string().max(10).optional().nullable(),

  nid: nidField.optional().nullable(),
  passport_number: passportField.optional().nullable(),
  passport: passportField.optional().nullable(), // frontend alias
  passport_issue: dateString.optional().nullable(),
  passport_expiry: dateString.optional().nullable(),

  permanent_address: z.string().max(500).optional().nullable(),
  current_address: z.string().max(500).optional().nullable(),

  father_name: z.string().max(200).optional().nullable(),
  father_name_en: z.string().max(200).optional().nullable(),
  father: z.string().max(200).optional().nullable(), // alias
  mother_name: z.string().max(200).optional().nullable(),
  mother_name_en: z.string().max(200).optional().nullable(),
  mother: z.string().max(200).optional().nullable(), // alias

  status: studentStatus.optional(),
  country: countryEnum.optional(),
  school_id: z.string().uuid().optional().nullable(),
  batch_id: z.string().uuid().optional().nullable(),
  intake: z.string().max(50).optional().nullable(),
  visa_type: z.string().max(50).optional().nullable(),
  source: z.string().max(50).optional().nullable(),
  agent_id: z.string().uuid().optional().nullable(),
  partner_id: z.string().uuid().optional().nullable(),
  referral_info: z.string().max(500).optional().nullable(),
  student_type: z.string().max(50).optional().nullable(),

  counselor: z.string().max(200).optional().nullable(),
  branch: z.string().max(100).optional(),

  gdrive_folder_url: z.string().url().optional().nullable(),
  photo_url: z.string().optional().nullable(),
  internal_notes: z.string().max(2000).optional().nullable(),

  // Resume fields
  birth_place: z.string().max(200).optional().nullable(),
  occupation: z.string().max(200).optional().nullable(),
  reason_for_study: z.string().max(2000).optional().nullable(),
  future_plan: z.string().max(2000).optional().nullable(),
  study_subject: z.string().max(200).optional().nullable(),

  // Passport-page fields
  spouse_name: z.string().max(200).optional().nullable(),
  emergency_contact: z.string().max(200).optional().nullable(),
  emergency_phone: phoneBD.optional().nullable(),
  father_dob: dateString.optional().nullable(),
  father_occupation: z.string().max(200).optional().nullable(),
  mother_dob: dateString.optional().nullable(),
  mother_occupation: z.string().max(200).optional().nullable(),

  preferred_region: z.string().max(100).optional().nullable(),
});

// POST /api/students — passthrough so STUDENT_COLUMNS-whitelisted extras still flow through.
const createStudentSchema = studentBase.passthrough();

// PATCH /api/students/:id — partial of base + optimistic-lock updated_at + passthrough.
const updateStudentSchema = studentBase
  .partial()
  .extend({
    updated_at: z.string().datetime().optional(),
  })
  .passthrough();

// GET /api/students — list query params
const listStudentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    search: z.string().max(200).optional(),
    status: z.string().max(50).optional(),
    country: z.string().max(50).optional(),
    batch: z.string().max(100).optional(),
    school: z.string().max(200).optional(),
    branch: z.string().max(100).optional(),
    intake: z.string().max(50).optional(),
    agent_id: z.string().uuid().optional(),
  })
  .passthrough();

module.exports = {
  createStudentSchema,
  updateStudentSchema,
  listStudentsQuerySchema,
};
