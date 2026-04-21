/**
 * systemContext.js — এজেন্সি, ব্যাচ, ব্রাঞ্চ, স্কুল context + SYSTEM_FIELDS list
 *
 * buildSystemContext: DB data → flat sys_* key-value map
 *   ব্যবহার: {{sys_agency_name}}, {{sys_batch_start:year}}, {{sys_today_jp}}
 *
 * SYSTEM_FIELDS: frontend-এ available field list দেখানোর জন্য
 * ALL_FIELD_KEYS: AI prompt validation-এ ব্যবহার
 */

/**
 * buildSystemContext — এজেন্সি, ব্যাচ, ব্রাঞ্চ, স্কুলের তথ্য flat key-value-তে
 * sys_* prefix দিয়ে রাখে — Excel template-এ {{sys_agency_name}} দিলে কাজ করবে
 */
function buildSystemContext(agency, batch, branch, school) {
  const ctx = {};
  const today = new Date();

  // ── এজেন্সি ──
  ctx.sys_agency_name = agency?.name || "";
  ctx.sys_agency_name_bn = agency?.name_bn || "";
  ctx.sys_agency_address = agency?.address || "";
  ctx.sys_agency_phone = agency?.phone || "";
  ctx.sys_agency_email = agency?.email || "";

  // ── ব্রাঞ্চ ──
  ctx.sys_branch_name = branch?.name || "";
  ctx.sys_branch_address = branch?.address || branch?.address_bn || "";
  ctx.sys_branch_phone = branch?.phone || "";
  ctx.sys_branch_manager = branch?.manager || "";

  // ── আজকের তারিখ ──
  ctx.sys_today = today.toISOString().slice(0, 10);
  ctx["sys_today:year"] = String(today.getFullYear());
  ctx["sys_today:month"] = String(today.getMonth() + 1).padStart(2, "0");
  ctx["sys_today:day"] = String(today.getDate()).padStart(2, "0");
  // 日本語 format: 2026年03月28日
  ctx.sys_today_jp = `${today.getFullYear()}年${String(today.getMonth()+1).padStart(2,"0")}月${String(today.getDate()).padStart(2,"0")}日`;

  // ── ব্যাচ ──
  ctx.sys_batch_name = batch?.name || "";
  ctx.sys_batch_teacher = batch?.teacher || "";
  ctx.sys_batch_schedule = batch?.schedule || "";
  const bStart = batch?.start_date || "";
  const bEnd = batch?.end_date || "";
  ctx.sys_batch_start = bStart;
  ctx.sys_batch_end = bEnd;
  if (bStart) {
    const d = new Date(bStart);
    ctx["sys_batch_start:year"] = String(d.getFullYear());
    ctx["sys_batch_start:month"] = String(d.getMonth()+1).padStart(2,"0");
    ctx["sys_batch_start:day"] = String(d.getDate()).padStart(2,"0");
  }
  if (bEnd) {
    const d = new Date(bEnd);
    ctx["sys_batch_end:year"] = String(d.getFullYear());
    ctx["sys_batch_end:month"] = String(d.getMonth()+1).padStart(2,"0");
    ctx["sys_batch_end:day"] = String(d.getDate()).padStart(2,"0");
  }

  // ── স্কুল ──
  ctx.sys_school_name = school?.name_en || "";
  ctx.sys_school_name_jp = school?.name_jp || "";
  ctx.sys_school_address = school?.address || "";

  return ctx;
}

// System fields for frontend — grouped display
const SYSTEM_FIELDS = [
  { group: "ব্যক্তিগত", source: "Student → Profile → Personal Info", fields: [
    { key: "name_en", label: "নাম (English)" }, { key: "name_bn", label: "নাম (বাংলা)" },
    { key: "name_katakana", label: "নাম (カタカナ)" }, { key: "dob", label: "জন্ম তারিখ" },
    { key: "dob:year", label: "জন্ম → বছর" }, { key: "dob:month", label: "জন্ম → মাস" }, { key: "dob:day", label: "জন্ম → দিন" },
    { key: "age", label: "বয়স (auto)" }, { key: "gender", label: "লিঙ্গ" },
    { key: "marital_status", label: "বৈবাহিক অবস্থা" }, { key: "nationality", label: "জাতীয়তা" },
    { key: "blood_group", label: "রক্তের গ্রুপ" }, { key: "phone", label: "ফোন" },
    { key: "whatsapp", label: "WhatsApp" }, { key: "email", label: "ইমেইল" },
    { key: "birth_place", label: "জন্মস্থান" }, { key: "occupation", label: "পেশা" },
    { key: "spouse_name", label: "স্বামী/স্ত্রীর নাম" },
    { key: "emergency_contact", label: "জরুরি যোগাযোগ" }, { key: "emergency_phone", label: "জরুরি ফোন" },
  ]},
  { group: "পাসপোর্ট / NID", source: "Student → Profile → Passport & Family", fields: [
    { key: "nid", label: "NID নম্বর" }, { key: "passport_number", label: "পাসপোর্ট নম্বর" },
    { key: "passport_issue", label: "পাসপোর্ট ইস্যু" }, { key: "passport_expiry", label: "পাসপোর্ট মেয়াদ" },
    { key: "passport_issue:year", label: "ইস্যু → বছর" }, { key: "passport_issue:month", label: "ইস্যু → মাস" }, { key: "passport_issue:day", label: "ইস্যু → দিন" },
    { key: "passport_expiry:year", label: "মেয়াদ → বছর" }, { key: "passport_expiry:month", label: "মেয়াদ → মাস" }, { key: "passport_expiry:day", label: "মেয়াদ → দিন" },
  ]},
  { group: "ঠিকানা", source: "Student → Profile → Personal Info", fields: [
    { key: "permanent_address", label: "স্থায়ী ঠিকানা" }, { key: "current_address", label: "বর্তমান ঠিকানা" },
  ]},
  { group: "পরিবার", source: "Student → Profile → Family Members (Add)", fields: [
    { key: "father_name_en", label: "পিতার নাম" }, { key: "mother_name_en", label: "মাতার নাম" },
    { key: "father_dob", label: "পিতার জন্ম তারিখ" }, { key: "father_occupation", label: "পিতার পেশা" },
    { key: "mother_dob", label: "মাতার জন্ম তারিখ" }, { key: "mother_occupation", label: "মাতার পেশা" },
    { key: "father_phone", label: "পিতার ফোন" }, { key: "mother_phone", label: "মাতার ফোন" },
  ]},
  { group: "শিক্ষা (SSC/HSC/Honours)", source: "Student → Profile → Education", fields: [
    { key: "edu_ssc_school", label: "SSC স্কুল" }, { key: "edu_ssc_year", label: "SSC সন" },
    { key: "edu_ssc_board", label: "SSC বোর্ড" }, { key: "edu_ssc_gpa", label: "SSC GPA" },
    { key: "edu_ssc_subject", label: "SSC বিভাগ" }, { key: "edu_ssc_address", label: "SSC ঠিকানা" },
    { key: "edu_ssc_entrance", label: "SSC ভর্তি সন" },
    { key: "edu_hsc_school", label: "HSC কলেজ" }, { key: "edu_hsc_year", label: "HSC সন" },
    { key: "edu_hsc_board", label: "HSC বোর্ড" }, { key: "edu_hsc_gpa", label: "HSC GPA" },
    { key: "edu_hsc_subject", label: "HSC বিভাগ" }, { key: "edu_hsc_address", label: "HSC ঠিকানা" },
    { key: "edu_hsc_entrance", label: "HSC ভর্তি সন" },
    { key: "edu_honours_school", label: "Honours বিশ্ববিদ্যালয়" }, { key: "edu_honours_year", label: "Honours সন" },
    { key: "edu_honours_gpa", label: "Honours GPA" }, { key: "edu_honours_subject", label: "Honours বিষয়" },
    { key: "edu_honours_address", label: "Honours ঠিকানা" }, { key: "edu_honours_entrance", label: "Honours ভর্তি সন" },
  ]},
  { group: "শিক্ষা (日本語履歴書)", source: "Student → Profile → Education (School Type select)", fields: [
    { key: "edu_elementary_school", label: "প্রাথমিক (小学校) স্কুল" }, { key: "edu_elementary_address", label: "প্রাথমিক ঠিকানা" },
    { key: "edu_elementary_entrance", label: "প্রাথমিক ভর্তি" }, { key: "edu_elementary_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_elementary_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_elementary_graduation", label: "প্রাথমিক পাশ" }, { key: "edu_elementary_graduation:year", label: "পাশ → বছর" }, { key: "edu_elementary_graduation:month", label: "পাশ → মাস" },
    { key: "edu_elementary_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_junior_school", label: "জুনিয়র হাই (中学校)" }, { key: "edu_junior_address", label: "জুনিয়র ঠিকানা" },
    { key: "edu_junior_entrance", label: "জুনিয়র ভর্তি" }, { key: "edu_junior_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_junior_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_junior_graduation", label: "জুনিয়র পাশ" }, { key: "edu_junior_graduation:year", label: "পাশ → বছর" }, { key: "edu_junior_graduation:month", label: "পাশ → মাস" },
    { key: "edu_junior_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_highSchool_school", label: "হাই স্কুল (高等学校)" }, { key: "edu_highSchool_address", label: "হাই স্কুল ঠিকানা" },
    { key: "edu_highSchool_entrance", label: "হাই স্কুল ভর্তি" }, { key: "edu_highSchool_entrance:year", label: "ভর্তি → বছর" }, { key: "edu_highSchool_entrance:month", label: "ভর্তি → মাস" },
    { key: "edu_highSchool_graduation", label: "হাই স্কুল পাশ" }, { key: "edu_highSchool_graduation:year", label: "পাশ → বছর" }, { key: "edu_highSchool_graduation:month", label: "পাশ → মাস" },
    { key: "edu_highSchool_years", label: "বছর সংখ্যা (auto)" },
    { key: "edu_technical_school", label: "টেকনিক্যাল (専門学校)" }, { key: "edu_technical_address", label: "ঠিকানা" },
    { key: "edu_technical_entrance", label: "ভর্তি" }, { key: "edu_technical_graduation", label: "পাশ" },
    { key: "edu_university_school", label: "বিশ্ববিদ্যালয় (大学)" }, { key: "edu_university_address", label: "ঠিকানা" },
    { key: "edu_university_entrance", label: "ভর্তি" }, { key: "edu_university_graduation", label: "পাশ" },
  ]},
  { group: "জাপানি ভাষা পরীক্ষা", source: "Student → Profile → JP Exams", fields: [
    { key: "jp_exam_type", label: "পরীক্ষার ধরন" }, { key: "jp_level", label: "লেভেল" },
    { key: "jp_score", label: "স্কোর" }, { key: "jp_result", label: "ফলাফল" },
    { key: "jp_exam_date", label: "পরীক্ষার তারিখ" }, { key: "jp_exam_date:year", label: "পরীক্ষা → বছর" }, { key: "jp_exam_date:month", label: "পরীক্ষা → মাস" }, { key: "jp_exam_date:day", label: "পরীক্ষা → দিন" },
  ]},
  { group: "জাপানি ভাষা শিক্ষা", source: "Auto: Agency নাম + Batch dates | Manual: JP Study Add", fields: [
    { key: "jp_study_institution", label: "প্রতিষ্ঠান" },
    { key: "jp_study_address", label: "প্রতিষ্ঠানের ঠিকানা" },
    { key: "jp_study_from", label: "শুরু তারিখ" }, { key: "jp_study_from:year", label: "শুরু → বছর" }, { key: "jp_study_from:month", label: "শুরু → মাস" }, { key: "jp_study_from:day", label: "শুরু → দিন" },
    { key: "jp_study_to", label: "শেষ তারিখ" }, { key: "jp_study_to:year", label: "শেষ → বছর" }, { key: "jp_study_to:month", label: "শেষ → মাস" }, { key: "jp_study_to:day", label: "শেষ → দিন" },
    { key: "jp_study_hours", label: "মোট ঘন্টা" },
  ]},
  { group: "কর্ম অভিজ্ঞতা (職歴)", source: "Student → Profile → Work Experience", fields: [
    { key: "work_company", label: "কোম্পানি নাম" }, { key: "work_address", label: "কোম্পানি ঠিকানা" },
    { key: "work_position", label: "পদবি" },
    { key: "work_start", label: "শুরু তারিখ" }, { key: "work_start:year", label: "শুরু → বছর" }, { key: "work_start:month", label: "শুরু → মাস" },
    { key: "work_end", label: "শেষ তারিখ" }, { key: "work_end:year", label: "শেষ → বছর" }, { key: "work_end:month", label: "শেষ → মাস" },
  ]},
  { group: "Study Plan", source: "Student → Profile → Purpose of Study", fields: [
    { key: "reason_for_study", label: "পড়ার কারণ" },
    { key: "future_plan", label: "ভবিষ্যৎ পরিকল্পনা" }, { key: "study_subject", label: "বিষয়" },
  ]},
  { group: "স্পন্সর", source: "Student → Sponsor Tab", fields: [
    { key: "sponsor_name", label: "নাম" }, { key: "sponsor_name_en", label: "নাম (EN)" },
    { key: "sponsor_relationship", label: "সম্পর্ক" }, { key: "sponsor_phone", label: "ফোন" },
    { key: "sponsor_dob", label: "জন্ম তারিখ" }, { key: "sponsor_dob:year", label: "জন্ম → বছর" }, { key: "sponsor_dob:month", label: "জন্ম → মাস" }, { key: "sponsor_dob:day", label: "জন্ম → দিন" },
    { key: "sponsor_nid", label: "NID" },
    { key: "sponsor_father_name", label: "পিতার নাম" }, { key: "sponsor_mother_name", label: "মাতার নাম" },
    { key: "sponsor_present_address", label: "বর্তমান ঠিকানা" }, { key: "sponsor_permanent_address", label: "স্থায়ী ঠিকানা" },
    { key: "sponsor_address", label: "ঠিকানা" },
    { key: "sponsor_company", label: "কোম্পানি" }, { key: "sponsor_company_phone", label: "কোম্পানি ফোন" },
    { key: "sponsor_company_address", label: "কোম্পানি ঠিকানা" }, { key: "sponsor_work_address", label: "কর্মস্থল" },
    { key: "sponsor_trade_license", label: "ট্রেড লাইসেন্স" },
    { key: "sponsor_tin", label: "TIN" },
    { key: "sponsor_income_year_1", label: "আয় সন (১ম)" }, { key: "sponsor_income_y1", label: "আয় (১ম)" }, { key: "sponsor_tax_y1", label: "ট্যাক্স (১ম)" },
    { key: "sponsor_income_year_2", label: "আয় সন (২য়)" }, { key: "sponsor_income_y2", label: "আয় (২য়)" }, { key: "sponsor_tax_y2", label: "ট্যাক্স (২য়)" },
    { key: "sponsor_income_year_3", label: "আয় সন (৩য়)" }, { key: "sponsor_income_y3", label: "আয় (৩য়)" }, { key: "sponsor_tax_y3", label: "ট্যাক্স (৩য়)" },
    { key: "sponsor_statement", label: "স্পন্সরশিপ বিবৃতি" },
  ]},
  { group: "গন্তব্য", source: "Student → Profile → Destination Info", fields: [
    { key: "country", label: "দেশ" }, { key: "intake", label: "Intake" },
    { key: "visa_type", label: "ভিসার ধরন" }, { key: "student_type", label: "টাইপ" },
    { key: "source", label: "সোর্স" }, { key: "branch", label: "ব্রাঞ্চ" }, { key: "status", label: "স্ট্যাটাস" },
  ]},
  { group: "সিস্টেম ভ্যারিয়েবল", source: "Auto: Settings / Batch / School থেকে", fields: [
    { key: "sys_agency_name", label: "এজেন্সি নাম" }, { key: "sys_agency_address", label: "এজেন্সি ঠিকানা" },
    { key: "sys_agency_phone", label: "এজেন্সি ফোন" }, { key: "sys_agency_email", label: "এজেন্সি ইমেইল" },
    { key: "sys_branch_name", label: "ব্রাঞ্চ নাম" }, { key: "sys_branch_address", label: "ব্রাঞ্চ ঠিকানা" },
    { key: "sys_today", label: "আজকের তারিখ" }, { key: "sys_today:year", label: "আজ → বছর" }, { key: "sys_today:month", label: "আজ → মাস" }, { key: "sys_today:day", label: "আজ → দিন" },
    { key: "sys_today_jp", label: "আজকের তারিখ (日本語)" },
    { key: "sys_batch_name", label: "ব্যাচ নাম" }, { key: "sys_batch_start", label: "ব্যাচ শুরু" },
    { key: "sys_batch_start:year", label: "শুরু → বছর" }, { key: "sys_batch_start:month", label: "শুরু → মাস" }, { key: "sys_batch_start:day", label: "শুরু → দিন" },
    { key: "sys_batch_end", label: "ব্যাচ শেষ" }, { key: "sys_batch_end:year", label: "শেষ → বছর" }, { key: "sys_batch_end:month", label: "শেষ → মাস" }, { key: "sys_batch_end:day", label: "শেষ → দিন" },
    { key: "sys_batch_teacher", label: "শিক্ষক" }, { key: "sys_batch_schedule", label: "সময়সূচী" },
    { key: "sys_school_name", label: "স্কুল (EN)" }, { key: "sys_school_name_jp", label: "স্কুল (JP)" }, { key: "sys_school_address", label: "স্কুল ঠিকানা" },
  ]},
];

// সব field keys একটি flat list-এ — AI prompt-এ ব্যবহার হবে
const ALL_FIELD_KEYS = SYSTEM_FIELDS.flatMap(g => g.fields.map(f => f.key));

module.exports = {
  buildSystemContext,
  SYSTEM_FIELDS,
  ALL_FIELD_KEYS,
};
