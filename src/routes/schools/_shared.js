/**
 * _shared.js — schools routes shared constants + multer config
 *
 * NUMERIC_COLS: numeric columns (string→number convert)
 * SCHOOL_COLS: valid DB columns list
 * templateUpload: multer config for interview template upload (5MB)
 * uploadDir: interview template storage path
 */

const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Schools table-এ numeric columns — frontend থেকে string আসলে convert করবে
const NUMERIC_COLS = [
  "shoukai_fee", "tuition_y1", "tuition_y2", "admission_fee",
  "facility_fee", "dormitory_fee", "capacity", "commission_rate",
];

// Valid columns — শুধু এগুলো DB-তে পাঠাবে (extra fields ফেলে দেবে)
const SCHOOL_COLS = [
  "name_en", "name_jp", "country", "city", "prefecture", "postal_code", "address",
  "contact_person", "contact_email", "contact_phone", "website",
  ...NUMERIC_COLS,
  "min_jp_level", "interview_type", "has_dormitory", "immigration_bureau",
  "deadline_april", "deadline_october", "status", "notes",
  // Smart Matching — intake-wise requirements + region
  "intake_requirements", "region",
];

// Interview template upload config
const uploadDir = path.join(__dirname, "../../../uploads/interview-templates");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const templateUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = { NUMERIC_COLS, SCHOOL_COLS, uploadDir, templateUpload };
