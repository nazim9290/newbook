/**
 * _shared.js — students routes-এ shared constants + multer config
 *
 * STUDENT_COLUMNS: students table-এর valid columns list (CRUD + import দুই জায়গায় ব্যবহার)
 * importUpload: Excel import-এর জন্য multer config (10MB limit)
 */

const multer = require("multer");
const path = require("path");

// students table-এ শুধু valid columns পাঠাও, বাকি সব ignore
const STUDENT_COLUMNS = [
  "id", "name_en", "name_bn", "name_katakana", "phone", "whatsapp", "email",
  "dob", "gender", "marital_status", "nationality", "blood_group", "nid",
  "passport_number", "passport_issue", "passport_expiry",
  "permanent_address", "current_address", "father_name", "father_name_en",
  "mother_name", "mother_name_en", "status", "country", "school_id", "batch_id",
  "intake", "visa_type", "source", "agent_id", "partner_id", "referral_info", "student_type",
  "counselor", "branch", "gdrive_folder_url", "photo_url", "internal_notes",
  // Resume fields — Excel入学願書 support
  "birth_place", "occupation", "reason_for_study", "future_plan", "study_subject",
  // Passport page fields — emergency contact, spouse, parents DOB/occupation
  "spouse_name", "emergency_contact", "emergency_phone",
  "father_dob", "father_occupation", "mother_dob", "mother_occupation",
  // Smart Matching — পছন্দের অঞ্চল (optional)
  "preferred_region",
  // Alumni snapshot — post-arrival current state (timeline lives in alumni_updates table)
  "alumni_current_status", "alumni_school_name", "alumni_school_start",
  "alumni_company_name", "alumni_company_position", "alumni_company_start",
  "alumni_city", "alumni_prefecture", "alumni_phone_jp", "alumni_email_jp",
  "alumni_last_contact", "alumni_referrals_count", "alumni_arrived_date", "alumni_notes",
];

// Import Excel upload — 10MB limit, uploads/ folder-এ temp save
const importUpload = multer({
  dest: path.join(__dirname, "../../../uploads"),
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { STUDENT_COLUMNS, importUpload };
