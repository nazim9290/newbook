/**
 * ocr.js — Generic Document OCR Route
 *
 * Config-driven approach — একটি genericParse() function সব document handle করে।
 * নতুন document type যোগ করতে শুধু DOC_CONFIGS array-তে config যোগ করলেই হবে।
 *
 * Google Cloud Vision API → text extract → auto-detect doc type → parse fields
 *
 * Environment: GOOGLE_VISION_API_KEY
 * Endpoint: POST /api/ocr/scan (multipart/form-data, field: "file")
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const auth = require("../middleware/auth");

router.use(auth);

// ── আপলোড কনফিগ — temp ফোল্ডারে ফাইল সেভ, max 10MB ──
const uploadDir = path.join(__dirname, "../../uploads/ocr-temp");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype));
  }
});

// ═══════════════════════════════════════════════════════════════
// GENERIC PARSER — config-driven field extraction
// ═══════════════════════════════════════════════════════════════

/**
 * genericParse(text, fieldConfigs) — OCR text থেকে config অনুযায়ী fields extract করে
 *
 * fieldConfig format:
 *   { key: "name_en", patterns: [/regex/], type: "text"|"date"|"number" }
 *   { key: "subjects", type: "table", pattern: /regex/g, columns: ["Subject","Grade","Point"] }
 */
function genericParse(text, fieldConfigs) {
  const fields = {};

  for (const fc of fieldConfigs) {
    if (fc.type === "table") {
      // Repeatable/table — multiple matches, store as Member1_Col, Member2_Col...
      const regex = new RegExp(fc.pattern.source, fc.pattern.flags);
      let match;
      let idx = 1;
      while ((match = regex.exec(text)) !== null) {
        const cols = fc.columns || [];
        cols.forEach((col, i) => {
          if (match[i + 1]) fields[`Member${idx}_${col}`] = match[i + 1].trim();
        });
        idx++;
      }
      continue;
    }

    // Normal field — try each pattern until one matches
    for (const pat of (fc.patterns || [])) {
      const match = text.match(pat);
      if (match && match[1]) {
        let value = match[1].trim();

        // Type-based post-processing
        if (fc.type === "date") {
          value = parseDate(value);
        } else if (fc.type === "number") {
          value = value.replace(/[\s,]/g, "");
        }

        if (value) {
          fields[fc.key] = value;
          break; // first matching pattern wins
        }
      }
    }
  }

  return fields;
}

/** তারিখ পার্সার — বিভিন্ন ফরম্যাটের তারিখকে YYYY-MM-DD-তে রূপান্তর করে
 *  "08 Jun 1978", "06/08/2023", "13 February, 2022" → "1978-06-08", "2023-08-06", "2022-02-13"
 */
function parseDate(raw) {
  if (!raw) return "";
  const months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
                   jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };

  // "08 Jun 1978" or "13 February, 2022"
  const named = raw.match(/(\d{1,2})\s*(\w{3,}),?\s*(\d{4})/i);
  if (named) {
    const m = months[named[2].toLowerCase().substring(0, 3)];
    if (m) return `${named[3]}-${m}-${named[1].padStart(2, "0")}`;
  }

  // "06/08/2023" or "06-08-2023" (DD/MM/YYYY)
  const numeric = raw.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (numeric) {
    let [, d, m, y] = numeric;
    if (y.length === 2) y = (parseInt(y) > 50 ? "19" : "20") + y;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return raw; // return as-is if can't parse
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT CONFIGS — প্রতিটি doc type-এর detection + field rules
// ═══════════════════════════════════════════════════════════════

// শেয়ার্ড regex প্যাটার্ন — একাধিক doc type-এ পুনরায় ব্যবহৃত হয়
const P = {
  name:       [/Name\s*(?:of\s*Student)?\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im],
  father:     [/Father['']?s?(?:\/Husband['']?s?)?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im],
  mother:     [/Mother['']?s?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im],
  permAddr:   [/Permanent\s*Address(?:\/Registered)?\s*[:\-]\s*(.+?)(?:\n(?:\d|[A-Z])|Date|$)/ims],
  curAddr:    [/(?:Current|Present)\s*Address\s*[:\-]\s*(.+?)(?:\n(?:\d|[A-Z])|$)/ims],
  nationality:[/Nationality\s*[:\-]\s*([A-Za-z]+)/i],
  taxCircle:  [/(?:Taxes?\s*)?Circle[:\-\s]*(\d+)/i],
  taxZone:    [/(?:Taxes?\s*)?Zone[:\-\s]*(\d+)/i],
  status:     [/Status\s*[:\-]\s*(Individual|Company|Firm)/i],
};

const DOC_CONFIGS = [
  // ── 0. ছাত্রত্ব সনদ (Studentship Certificate) — কলেজ/বিশ্ববিদ্যালয়ের ছাত্র প্রমাণপত্র ──
  {
    id: "studentship_certificate",
    detect: /TO\s*WHOM\s*IT\s*MAY\s*CONCERN|regular\s*student|running\s*student|studentship/i,
    fields: [
      { key: "institution_name", patterns: [/^([\w\s]+(?:College|University|Institute|School))/im, /(?:Department\s*of[\s\S]*?)([\w\s]+(?:College|University))/im] },
      { key: "department", patterns: [/Department\s*of\s*([\w\s&]+?)(?:\n|$)/im] },
      { key: "institution_address", patterns: [/([\w\s,\-]+\d{4})\s*$/im] },
      { key: "name_en", patterns: [/(?:certify\s*that|certify\s*,?\s*that)\s+([A-Z][A-Za-z\s.]+?)(?:,\s*(?:son|daughter)|$)/im] },
      { key: "father_name", patterns: [/(?:son|daughter)\s*of\s*([A-Z][A-Za-z\s.]+?)(?:\s*\(father\)|\s*and)/im] },
      { key: "mother_name", patterns: [/(?:and)\s*([A-Z][A-Za-z\s.]+?)(?:\s*\(mother\))/im] },
      { key: "degree", patterns: [/(?:in\s*the\s*)([\w\s]+?)(?:\s*in\s+\w+\s*program|\s*program)/im] },
      { key: "subject", patterns: [/(?:in\s+)(Management|[\w\s]+?)\s*program/im] },
      { key: "year", patterns: [/(?:in\s*his|in\s*her)\s*(\d+(?:st|nd|rd|th)?\s*year)/im] },
      { key: "roll_no", patterns: [/(?:roll\s*(?:number|no)\.?\s*(?:is)?)\s*(\d+)/im] },
      { key: "session", patterns: [/(?:session\s*(?:is)?)\s*([\d\-\/]+)/im] },
      { key: "student_type", patterns: [/(regular|irregular|private)\s*student/im] },
    ],
    postProcess: (fields) => {
      if (fields.student_type) fields.student_type = fields.student_type.charAt(0).toUpperCase() + fields.student_type.slice(1).toLowerCase();
    },
    confidence: ["name_en", "institution_name", "degree"],
  },

  // ── 0a. জাপানি ভাষা শিক্ষা সনদ (学習証明書) — Proficiency-এর আগে detect করতে হবে ──
  {
    id: "learning_certificate",
    detect: /Learning\s*Certificate|学習証明書/i,
    fields: [
      { key: "ref_no", patterns: [/(?:Ref|Sl\.?\s*No)[:\-.\s]*([\w\-\/]+)/i] },
      { key: "cert_date", patterns: [/Date[:\-\s]*(\d{4}[\/-]\d{2}[\/-]\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "institute_name", patterns: [/^([A-Z][\w\s]+(?:Institute|School|Academy|Centre))/im] },
      { key: "name_en", patterns: [/(?:Name\s*of\s*(?:the\s*)?Student|学生の名前)\s*[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|$)/im] },
      { key: "student_id", patterns: [/Student\s*ID\s*(?:\(学生証\))?\s*[:\-]?\s*([\w\-\/]+)/i] },
      { key: "learning_period", patterns: [/(?:Learning\s*Period|日本語学習期間)\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "course_level", patterns: [/(?:Level|レベル)\s*[:\-]?\s*(N[1-5])/i] },
      { key: "reference_book", patterns: [/(?:Reference\s*Book|参考書)\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "total_classes", patterns: [/(?:Total\s*Number\s*of\s*Class|クラス総数)\s*[:\-]?\s*(\d+)/i] },
      { key: "total_hours", patterns: [/(?:Total\s*Number\s*of\s*Hours|総時間数)\s*[:\-]?\s*(\d+)/i] },
      { key: "class_duration", patterns: [/(?:Duration\s*of\s*Class\s*Per\s*day|日あたり)\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "weekly_duration", patterns: [/(?:Duration.*?Per\s*Week|週あたり)\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "class_time", patterns: [/(?:Class\s*Time|授業時間)\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "attendance_rate", patterns: [/(?:Attendance\s*Rate|出席.*?率)\s*[:\-]?\s*(\d+%?)/i] },
      { key: "total_study_hours", patterns: [/(?:Total\s*Study\s*Hour|総学習時間)\s*[:\-]?\s*(\d+)/i] },
      { key: "class_test_rate", patterns: [/(?:Class\s*Test.*?Rate|クラステスト.*?率)\s*[:\-]?\s*(\d+%?)/i] },
      // Skill scores table
      { key: "skills", type: "table", pattern: /(Listening|Speaking|Reading|Writing)\s*[:\-]?\s*(?:\([^)]*\)\s*)?(\d+%?)/gi, columns: ["Skill", "Score"] },
    ],
    confidence: ["name_en", "student_id", "course_level"],
  },

  // ── 0b. জাপানি ভাষা দক্ষতা সনদ (日本語能力証明書) — JLPT/NAT লেভেল, গ্রেড, সময়কাল ──
  {
    id: "language_proficiency_certificate",
    detect: /(?:Language|Japanese)\s*(?:Proficiency|能力)\s*Certificate|日本語能力証明書/i,
    fields: [
      { key: "sl_no", patterns: [/(?:Sl\.?\s*No|Ref)[:\-.\s]*([\w\-\/]+)/i] },
      { key: "institute_name", patterns: [/^([A-Z][\w\s]+(?:Institute|School|Academy|Centre))/im] },
      { key: "cert_date", patterns: [/Date[:\-\s]*(\d{4}[\/-]\d{2}[\/-]\d{2})/i], type: "date" },
      { key: "name_en", patterns: [/Name\s*(?:\(名前\))?[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|Date|$)/im] },
      { key: "father_name", patterns: [/Father['']?s?\s*name\s*(?:\([^)]*\))?[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|Mother|$)/im] },
      { key: "mother_name", patterns: [/Mother['']?s?\s*name\s*(?:\([^)]*\))?[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|Student|$)/im] },
      { key: "student_id", patterns: [/Student\s*ID\s*(?:No)?\.?\s*(?:\([^)]*\))?[:\-]?\s*([\w\-\/]+)/i] },
      { key: "dob", patterns: [/Date\s*of\s*birth\s*(?:\([^)]*\))?[:\-]?\s*(\d{4}[\/-]\d{2}[\/-]\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "course_level", patterns: [/(N[1-5])\s*Japanese/i, /completed.*?(N[1-5])/i, /Level[:\-\s]*(N[1-5])/i] },
      { key: "total_hours", patterns: [/(\d+)\s*hours?\s*(?:Japanese|Language)/i, /completed\s*(\d+)\s*hours/i] },
      { key: "attended_hours", patterns: [/attends?\s*\.?(\d+)\.?\s*hours/i] },
      { key: "grade", patterns: [/Grade\s*\.?\.?\s*([A-F][+-]?)/i, /obtained\s*Grade\s*\.?\.?\s*([A-F][+-]?)/i] },
      { key: "course_from", patterns: [/(?:From|Duration)[:\-.\s]*(\d{4}[\/-]\d{2}[\/-]\d{2})/i], type: "date" },
      { key: "course_to", patterns: [/(?:to)\s*\.?\.?\s*(\d{4}[\/-]\d{2}[\/-]\d{2})/i], type: "date" },
    ],
    confidence: ["name_en", "course_level", "institute_name"],
  },

  // ── 0c. পাসপোর্ট (বাংলাদেশ MRP) — ব্যক্তিগত তথ্য, MRZ fallback সহ ──
  {
    id: "passport",
    detect: /PASSPORT|PEOPLE['']?S\s*REPUBLIC\s*OF\s*BANGLADESH|P<BGD/i,
    fields: [
      { key: "passport_number", patterns: [/Passport\s*(?:No|Number)\s*[:\-]?\s*([A-Z]\d{7,8})/i, /\b([A-Z]\d{7,8})\b/] },
      { key: "type", patterns: [/Type\s*[:\-]?\s*([PDS])\b/i] },
      { key: "country_code", patterns: [/Country\s*Code\s*[:\-]?\s*([A-Z]{3})/i] },
      { key: "surname", patterns: [/Surname\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "given_name", patterns: [/Given\s*Name[s]?\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "nationality", patterns: [/Nationality\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "personal_no", patterns: [/Personal\s*(?:No|Number)\s*[:\-]?\s*(\d{10,})/i] },
      { key: "dob", patterns: [/Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}\s*\w{3,}\s*\d{4})/i], type: "date" },
      { key: "sex", patterns: [/Sex\s*[:\-]?\s*([MF])\b/i] },
      { key: "birth_place", patterns: [/Place\s*of\s*Birth\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "date_of_issue", patterns: [/Date\s*of\s*Issue\s*[:\-]?\s*(\d{1,2}\s*\w{3,}\s*\d{4})/i], type: "date" },
      { key: "date_of_expiry", patterns: [/Date\s*of\s*Expiry\s*[:\-]?\s*(\d{1,2}\s*\w{3,}\s*\d{4})/i], type: "date" },
      { key: "issuing_authority", patterns: [/Issuing\s*Authority\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "father_name", patterns: [/Father['']?s?\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|$)/im] },
      { key: "mother_name", patterns: [/Mother['']?s?\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|$)/im] },
      { key: "permanent_address", patterns: [/Permanent\s*Address\s*[:\-]?\s*(.+?)(?:\nEmergency|\nTelephone|$)/ims] },
      { key: "emergency_name", patterns: [/Emergency[\s\S]*?Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+?)(?:\n|$)/im] },
      { key: "emergency_relationship", patterns: [/Relationship\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "emergency_address", patterns: [/Emergency[\s\S]*?Address\s*[:\-]?\s*(.+?)(?:\nTelephone|$)/ims] },
      { key: "emergency_phone", patterns: [/Telephone\s*(?:No)?\.?\s*[:\-]?\s*(\+?\d[\d\s\-]+)/i] },
      { key: "previous_passport_no", patterns: [/Previous\s*Passport\s*(?:No)?\.?\s*[:\-]?\s*([A-Z]?\d{6,})/i] },
    ],
    postProcess: (fields, text) => {
      // MRZ লাইন থেকে passport number extract — OCR মূল text-এ না পেলে fallback
      if (!fields.passport_number) {
        const mrz = text.match(/P<BGD([A-Z]+)<<([A-Z]+)/);
        if (mrz) { fields.surname = mrz[1]; fields.given_name = mrz[2]; }
        const mrzNum = text.match(/([A-Z]\d{7,8})BGD/);
        if (mrzNum) fields.passport_number = mrzNum[1];
      }
    },
    confidence: ["passport_number", "surname", "given_name", "dob"],
  },

  // ── 1. পারিবারিক সম্পর্ক সনদ — ইউনিয়ন/পৌরসভা থেকে পরিবারের সদস্য তালিকা ──
  {
    id: "family_relation_certificate",
    detect: /Family\s*Relation\s*Certificate/i,
    fields: [
      { key: "certificate_no", patterns: [/(?:স্মারক|memo|ref)\s*(?:নং|no)?[:\-\s]*([\w\-\/:.]+\d{2,})/i] },
      { key: "issue_date", patterns: [/(?:তারিখ|Date)[:\-\s]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "issuing_authority", patterns: [/([\w\s]+Union\s*Parishad|[\w\s]+Paurashava|[\w\s]+City\s*Corporation)/i] },
      { key: "applicant_name", patterns: [/family\s*of\s+([A-Z][A-Za-z\s.]+?)(?:,|\.|Father)/i] },
      { key: "father_name", patterns: [/Father['']?s?\s*Name[:\-\s]*([A-Z][A-Za-z\s.]+?)(?:,|\.|Mother)/i] },
      { key: "mother_name", patterns: [/Mother['']?s?\s*Name[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:,|\.|Vill)/i] },
      { key: "village", patterns: [/Vill[:\s]*([\w\s]+?)(?:,|P\.?o|$)/im] },
      { key: "post_office", patterns: [/P\.?o\.?[:\s]*([\w\s]+?)(?:,|P\.?s|$)/im] },
      { key: "police_station", patterns: [/P\.?s[:\s.]*([\w\s]+?)(?:,|Dist|Sadar|$)/im] },
      { key: "district", patterns: [/Dist[:\s.]*([\w\s]+?)(?:,|\.|$)/im] },
      // পরিবারের সদস্য টেবিল — "01 SIFAT SHEIKH MYSELF 07-10-2001" ফরম্যাটে parse
      { key: "members", type: "table", pattern: /\d{1,2}\s+([A-Z][A-Za-z\s.]+?)\s+(MYSELF|FATHER|MOTHER|BROTHER|SISTER|SPOUSE|SON|DAUGHTER|UNCLE|AUNT)\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/gi, columns: ["Name", "Relation", "DOB"] },
    ],
    confidence: ["applicant_name", "father_name"],
  },

  // ── 1a. জাতীয় পরিচয়পত্র (NID — পুরাতন ল্যামিনেটেড + স্মার্ট কার্ড) ──
  {
    id: "sponsor_nid",
    detect: /National\s*ID\s*Card|জাতীয় পরিচয়|ID\s*NO\s*:|NID\s*No/i,
    fields: [
      { key: "nid_format", patterns: [/./], type: "text" }, // set by post-process
      { key: "nid_number", patterns: [/(?:ID\s*NO|NID\s*No)\.?\s*[:\-]?\s*([\d\s]{10,})/i], type: "number" },
      { key: "name_en", patterns: [/Name\s*[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:\n|পিতা|Father|$)/im] },
      { key: "father_name", patterns: [/(?:Father|পিতা)\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|Mother|মাতা|$)/im] },
      { key: "mother_name", patterns: [/(?:Mother|মাতা)\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|Date|$)/im] },
      { key: "dob", patterns: [/Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}\s*\w+\s*\d{4})/i, /Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "blood_group", patterns: [/Blood\s*Group\s*[:\-]?\s*([ABO]{1,2}[+-])/i] },
      { key: "birth_place", patterns: [/Place\s*of\s*Birth\s*[:\-]?\s*([A-Z]+)/i] },
      { key: "address", patterns: P.permAddr },
      { key: "issue_date", patterns: [/Issue\s*Date\s*[:\-]?\s*(\d{1,2}\s*\w+\s*\d{4})/i], type: "date" },
    ],
    postProcess: (fields, text) => {
      fields.nid_format = /Place\s*of\s*Birth/i.test(text) ? "Smart Card" : "Old (Laminated)";
      // NID from MRZ fallback
      if (!fields.nid_number) {
        const m = text.match(/I<BGD(\d{10,})/);
        if (m) fields.nid_number = m[1].substring(0, 10);
      }
    },
    confidence: ["nid_number", "name_en", "dob"],
  },

  // ── 2. ট্রেড লাইসেন্স — ব্যবসার নাম, মালিক, BIN, ফি টেবিল ──
  {
    id: "trade_license",
    detect: /Trade\s*License|E-Trade/i,
    fields: [
      { key: "license_no", patterns: [/License\s*No\s*[:\-]?\s*([\w\/\-]+)/i] },
      { key: "issue_date", patterns: [/Issue\s*Date\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "valid_upto", patterns: [/Valid\s*(?:Upto?|Until)\s*(\d{1,2}\s*\w+\s*\w*\s*\d{4})/i] },
      { key: "financial_year", patterns: [/Financial\s*Year\s*[:\-]?\s*([\d\-\/]+)/i] },
      { key: "issuing_authority", patterns: [/([\w\s]+City\s*Corporation|[\w\s]+Paurashava)/i] },
      { key: "business_name", patterns: [/Business\s*Name\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "business_type", patterns: [/Business\s*Type\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "business_category", patterns: [/Business\s*Category\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "business_address", patterns: [/Business\s*Address\s*[:\-]?\s*(.+?)(?:\n|$)/im] },
      { key: "bin_no", patterns: [/BIN\s*(?:NO|Number)?\s*[:\-]?\s*(\d+)/i] },
      { key: "owner_name", patterns: [/Owner['']?s?\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im] },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "nid_passport", patterns: [/NID[\w\/]*\s*(?:Reg)?[\s:]*No\s*[:\-]?\s*(\d+)/i] },
      { key: "grand_total", patterns: [/Grand\s*Total\s*[:\-]?\s*([\d,]+)/i], type: "number" },
      // ফি টেবিল — License Fee, Tax, VAT ইত্যাদি
      { key: "fees", type: "table", pattern: /([\w\/\s]+?(?:Fee|Tax|VAT|Surcharge))\s*[:\-]?\s*([\d,.]+)/gi, columns: ["Item", "Amount"] },
    ],
    confidence: ["license_no", "business_name", "owner_name"],
  },

  // ── 3. TIN সনদ — করদাতা সনাক্তকরণ নম্বর (e-TIN), ঠিকানা, সার্কেল/জোন ──
  {
    id: "tin_certificate",
    detect: /TIN|Taxpayer[\s\S]{0,20}Identification[\s\S]{0,20}Number/i,
    reject: /birth/i, // "birth" শব্দ থাকলে TIN না — Birth Certificate হতে পারে, তাই skip
    fields: [
      { key: "tin_number", patterns: [/(?:TIN|e-TIN)\s*[:\-]?\s*(\d{12})/i] },
      { key: "name_en", patterns: P.name },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "current_address", patterns: P.curAddr },
      { key: "permanent_address", patterns: P.permAddr },
      { key: "taxes_circle", patterns: P.taxCircle },
      { key: "taxes_zone", patterns: P.taxZone },
      { key: "status", patterns: P.status },
      { key: "issue_date", patterns: [/Date\s*[:\-]\s*(\w+\s+\d{1,2},?\s*\d{4})/i], type: "date" },
      { key: "previous_tin", patterns: [/Previous\s*TIN\s*[:\-]\s*(.+?)(?:\n|$)/i] },
    ],
    confidence: ["tin_number", "name_en"],
  },

  // ── 4. আয়কর সনদ — e-TIN, কর পরিশোধ টেবিল (বছর ও পরিমাণ) ──
  {
    id: "income_tax_certificate",
    detect: /Income\s*Tax\s*Certificate/i,
    fields: [
      { key: "etin", patterns: [/(?:TIN|e-TIN)\s*[:\-]?\s*(\d{12})/i] },
      { key: "name_en", patterns: P.name },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "present_address", patterns: P.curAddr },
      { key: "permanent_address", patterns: P.permAddr },
      { key: "status", patterns: P.status },
      { key: "business_id", patterns: [/Business\s*Identification\s*Number\s*[:\-]?\s*(.+?)(?:\n|$)/i] },
      { key: "taxes_circle", patterns: P.taxCircle },
      { key: "taxes_zone", patterns: P.taxZone },
      // কর পরিশোধের টেবিল — বছর ও পরিমাণ
      { key: "tax_payments", type: "table", pattern: /(\d{4}[-–]\d{4}).*?(?:paid\s*)?Tk\.?\s*([\d,]+)/gi, columns: ["Year", "Amount"] },
    ],
    confidence: ["etin", "name_en"],
  },

  // ── 5. বার্ষিক আয়ের সনদ — আয়ের উৎস, বছর, পরিমাণ টেবিল ──
  {
    id: "annual_income_certificate",
    detect: /Annual\s*In[oc]ome\s*Certificate/i,
    fields: [
      { key: "name_en", patterns: [/Name\s*(?:Mr\/Mrs\/M\/S)?\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im] },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "permanent_address", patterns: P.permAddr },
      { key: "present_address", patterns: P.curAddr },
      // আয়ের উৎস টেবিল — Source, Year, Amount
      { key: "income", type: "table", pattern: /\d+\s+([\w\s]+?)\s*\((\d{4}[-–]\d{4})\)\s*([\d,]+)/gi, columns: ["Source", "Year", "Amount"] },
    ],
    confidence: ["name_en"],
  },

  // ── 6. জন্ম নিবন্ধন সনদ — বাংলা+ইংরেজি মিশ্র OCR, পৌরসভা/সিটি কর্পোরেশন/ইউনিয়ন ──
  {
    id: "birth_certificate",
    detect: /birth\s*(registration|certificate)|জন্ম\s*নিবন্ধন/i,
    fields: [
      // ১৭ সংখ্যার রেজিস্ট্রেশন নম্বর — BR Number বা Birth Registration Number
      { key: "birth_reg_no", patterns: [/\b(\d{17})\b/, /BR\s*Number[\s\n]*[:\-]?\s*(\d[\s\d|]*\d)/i] },
      { key: "register_no", patterns: [/Register\s*No\.?[\s\n]*[:\-]?\s*(\d+)/i], type: "number" },

      // Name — Format 1: "Name\n: Sifat Sheikh", Format 2: "Name: Arpita Roy"
      { key: "name_en", patterns: [
        /(?:^|\n)\s*Name[\s\n]*[:\-]\s*([A-Z][A-Za-z\s.]+?)(?:\n|মাতা|Mother|পিতা|Father|Date|$)/im,
        /Name[\s\n]*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/im,
      ] },

      // DOB — "10/07/2001" or box digits "2 1 1 0 2 0 0 5"
      { key: "dob", patterns: [
        /Date\s*of\s*Birth[\s\n]*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
        /Birth[\s\n]*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      ], type: "date" },
      { key: "dob_in_word", patterns: [
        /[Ii]n\s*[Ww]ord[\s\n]*[:\-]?\s*([A-Z][A-Za-z\s,]+?(?:Thousand|Hundred|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s*[A-Za-z\s]*)/i,
      ] },
      { key: "sex", patterns: [/Sex[\s\n]*[:\-]?\s*(Male|Female|Other)/i] },

      // Place of Birth
      { key: "birth_place", patterns: [
        /Place\s*of\s*Birth[\s\n]*[:\-]?\s*([A-Za-z][A-Za-z\s,.\-]+?)(?:\n|স্থায়ী|Permanent|Order|$)/i,
      ] },

      // Father — Format 1: "Father\n: Karim Sheikh", Format 2: "Father's Name: Khagen Roy"
      { key: "father_name", patterns: [
        /Father['']?s?\s*Name[\s\n]*[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:\n|Father|BRN|NID|$)/im,
        /Father[\s\n]*[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:\n|Nationality|জাতীয়তা|পিতার|$)/im,
      ] },
      { key: "father_nationality", patterns: [
        /Father['']?s?\s*Nationality[\s\n]*[:\-]?\s*(Bangladeshi|[A-Z][a-z]+)/i,
      ] },

      // Mother — Format 1: "Mother\nAyesha Begum", Format 2: "Mother's Name: Kanchan Roy"
      { key: "mother_name", patterns: [
        /Mother['']?s?\s*Name[\s\n]*[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:\n|Mother|BRN|NID|$)/im,
        /Mother[\s\n]*[:\-]?\s*([A-Z][A-Za-z\s.]+?)(?:\n|Nationality|জাতীয়তা|মাতার|$)/im,
      ] },
      { key: "mother_nationality", patterns: [
        /Mother['']?s?\s*Nationality[\s\n]*[:\-]?\s*(Bangladeshi|[A-Z][a-z]+)/i,
      ] },

      // Permanent Address
      { key: "permanent_address", patterns: [
        /Permanent[\s\n]*Address[\s\n]*[:\-]?\s*([A-Za-z][A-Za-z\d\s,.\-\/\n]+?)(?:\n\n|\nDate|\nThis|\nFather|$)/i,
      ] },

      // Dates
      { key: "reg_date", patterns: [
        /Date\s*of\s*Registration[\s\n]*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      ], type: "date" },
      { key: "issue_date", patterns: [
        /Date\s*of\s*Issu(?:e|ance)[\s\n]*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      ], type: "date" },

      // Authority
      { key: "paurashava_name", patterns: [/([\w\s]+?)\s*Paurashava/i] },
      { key: "zone", patterns: [/Zone[:\-\s]*(\d+)/i] },
      { key: "city_corp_name", patterns: [/([\w\s]+?)\s*City\s*Corporation/i] },
      { key: "union_name", patterns: [/([\w\s]+?)\s*Union\s*Parishad/i] },
      { key: "upazila_name", patterns: [/Upazila[\s\n]*[:\-]?\s*([\w\s]+?)(?:,|\n|$)/i] },
      { key: "district_name", patterns: [/District[\s\n]*[:\-]?\s*([\w\s]+?)(?:,|\n|$)/i] },

      // Format 2 specific — BRN, NID, Order of Child
      { key: "father_brn", patterns: [/Father['']?s?\s*BRN[\s\n]*[:\-]?\s*(\d+)/i] },
      { key: "father_nid", patterns: [/Father['']?s?\s*NID[\s\n]*[:\-]?\s*(\d+)/i] },
      { key: "mother_brn", patterns: [/Mother['']?s?\s*BRN[\s\n]*[:\-]?\s*(\d+)/i] },
      { key: "mother_nid", patterns: [/Mother['']?s?\s*NID[\s\n]*[:\-]?\s*(\d+)/i] },
      { key: "order_of_child", patterns: [/Order\s*of\s*Child[\s\n]*[:\-]?\s*(\d+)/i] },
    ],
    postProcess: (fields, text) => {
      // টেমপ্লেট ধরন স্বয়ংক্রিয়ভাবে চিনবে — পৌরসভা/সিটি কর্পোরেশন/ইউনিয়ন
      if (/paurashava/i.test(text)) fields.template_type = "Paurashava";
      else if (/city corporation/i.test(text)) fields.template_type = "City Corporation";
      else if (/union parishad/i.test(text)) fields.template_type = "Union Parishad";

      // Header থেকে location extract — "Munshiganj Sadar, Munshiganj"
      const headerLocMatch = text.match(/(?:Union\s*Parishad|Paurashava|City\s*Corporation)\s*\n\s*([A-Za-z\s]+?)(?:,\s*([A-Za-z\s]+?))?(?:\n|$)/i);
      if (headerLocMatch) {
        if (!fields.upazila_name && headerLocMatch[1]) fields.upazila_name = headerLocMatch[1].trim();
        if (!fields.district_name && headerLocMatch[2]) fields.district_name = headerLocMatch[2].trim();
      }
    },
    confidence: ["birth_reg_no", "name_en", "dob", "father_name", "mother_name"],
  },

  // ── 7. SSC/HSC একাডেমিক ট্রান্সক্রিপ্ট — বোর্ড, রোল, GPA, বিষয়ভিত্তিক গ্রেড টেবিল ──
  {
    id: "academic_transcript",
    detect: /secondary\s*certificate|SSC|HSC|intermediate|academic\s*transcript/i,
    fields: [
      { key: "board_name", patterns: [/Board\s*of\s*([\w\s&]+?,\s*[\w]+)/i] },
      { key: "exam_year", patterns: [/Examination[,\s]*(\d{4})/i] },
      { key: "serial_no", patterns: [/Serial\s*No\.?\s*:?\s*([\w\s]+\d{5,})/i] },
      { key: "name_en", patterns: P.name },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "institution", patterns: [/(?:Name\s*of\s*)?Institution\s*[:\-]\s*(.+?)(?:\n|$)/im] },
      { key: "centre", patterns: [/(?:Name\s*of\s*)?Centre\s*[:\-]\s*(.+?)(?:\n|$)/im] },
      { key: "roll_no", patterns: [/Roll\s*No\.?\s*[:\-]?\s*([\d\s]+?)(?:\n|Registration|$)/im] },
      { key: "registration_no", patterns: [/Registration\s*No\.?\s*[:\-]?\s*([\d\/\-]+)/im] },
      { key: "group", patterns: [/Group\s*[:\-]?\s*(Science|Commerce|Arts|Humanities)/im] },
      { key: "student_type", patterns: [/Type\s*(?:of\s*Student)?\s*[:\-]?\s*(Regular|Irregular|Private)/im] },
      { key: "gpa", patterns: [/G\.?P\.?A\.?\s*[:\-]?\s*(\d\.\d{2})/i, /\b(\d\.\d{2})\b/] },
      { key: "result_date", patterns: [/(?:Date\s*of\s*Publication|Date\s*of\s*Results?)\s*[:\-]?\s*(\d{1,2}\s+\w+,?\s*\d{4})/im] },
      // বিষয়ভিত্তিক ফলাফল টেবিল — Subject, Grade, Point
      { key: "subjects", type: "table", pattern: /\d?\s*([\w\s&]{3,40}?)\s+(A\+|A\-?|B\+?|C\+?|D|F)\s+(\d\.?\d*)/g, columns: ["Subject", "Grade", "Point"] },
    ],
    postProcess: (fields, text) => {
      // SSC নাকি HSC — text থেকে পরীক্ষার ধরন চিনবে
      if (/higher\s*secondary|HSC/i.test(text)) fields._exam_type = "HSC";
      else if (/secondary\s*school|SSC/i.test(text)) fields._exam_type = "SSC";

      // চতুর্থ বিষয়সহ GPA — দ্বিতীয় GPA match থাকলে additional হিসেবে সেভ
      const gpas = text.match(/\b(\d\.\d{2})\b/g);
      if (gpas && gpas.length >= 2 && gpas[1] !== gpas[0]) {
        fields.gpa = gpas[0];
        fields.gpa_with_additional = gpas[1];
      }
    },
    confidence: ["name_en", "roll_no", "gpa", "exam_year"],
  },
];

// ═══════════════════════════════════════════════════════════════
// AUTO-DETECT + PARSE — config থেকে সঠিক parser বের করে চালায়
// ═══════════════════════════════════════════════════════════════

function detectAndParse(text) {
  // Step 1: detect pattern match — প্রথম match-ই ব্যবহার হবে
  for (const config of DOC_CONFIGS) {
    if (config.detect.test(text)) {
      if (config.reject && config.reject.test(text)) continue; // reject pattern match করলে skip
      const fields = genericParse(text, config.fields);
      if (config.postProcess) config.postProcess(fields, text);
      const keyCount = (config.confidence || []).filter(k => fields[k]).length;
      fields._confidence = keyCount >= Math.ceil(config.confidence.length * 0.6) ? "high"
                         : keyCount >= 1 ? "medium" : "low";
      return { docType: config.id, fields };
    }
  }

  // Step 2: fallback — সব config try করে সবচেয়ে বেশি field match
  let best = { docType: "unknown", fields: {}, count: 0 };
  for (const config of DOC_CONFIGS) {
    const fields = genericParse(text, config.fields);
    if (config.postProcess) config.postProcess(fields, text);
    const count = Object.keys(fields).filter(k => !k.startsWith("_")).length;
    if (count > best.count) {
      const keyCount = (config.confidence || []).filter(k => fields[k]).length;
      fields._confidence = keyCount >= Math.ceil(config.confidence.length * 0.6) ? "high"
                         : keyCount >= 1 ? "medium" : "low";
      best = { docType: config.id, fields, count };
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
// CREDIT SYSTEM HELPERS
// ═══════════════════════════════════════════════════════════════
const supabase = require("../lib/supabase");

// Agency-র OCR credit balance চেক
async function getOcrCredits(agencyId) {
  const { data } = await supabase.from("agencies").select("ocr_credits").eq("id", agencyId).single();
  return data?.ocr_credits || 0;
}

// Credit deduct + usage log + transaction log
// প্রতি scan-এ 5 credit deduct (৳1 = 1 credit, ৳5/scan)
const CREDITS_PER_SCAN = 5;

async function deductCredit(agencyId, userId, meta) {
  // Credit 5 কমাও — raw SQL দিয়ে atomic update
  const { pool } = supabase;
  try {
    await pool.query("UPDATE agencies SET ocr_credits = GREATEST(0, ocr_credits - $1) WHERE id = $2", [CREDITS_PER_SCAN, agencyId]);
  } catch (e) { console.error("[OCR Credit Deduct]", e.message); }

  // নতুন balance আনো
  const newBalance = await getOcrCredits(agencyId);

  // Usage log — কোন document কে scan করলো
  await supabase.from("ocr_usage").insert({
    agency_id: agencyId, user_id: userId,
    doc_type: meta.docType || "unknown", engine: meta.engine || "haiku",
    credits_used: CREDITS_PER_SCAN, confidence: meta.confidence || "low",
    fields_extracted: meta.fieldsCount || 0, file_name: meta.fileName || "",
  }).catch(() => {});

  // Transaction log — credit deduct record
  await supabase.from("ocr_credit_log").insert({
    agency_id: agencyId, amount: -CREDITS_PER_SCAN, balance_after: newBalance,
    type: "scan", description: `OCR scan: ${meta.docType || "unknown"} (${meta.engine})`,
    created_by: userId,
  }).catch(() => {});

  return newBalance;
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE HAIKU VISION — AI-powered field extraction
// Google Vision raw text → Haiku → structured JSON
// ═══════════════════════════════════════════════════════════════
async function extractWithHaiku(rawText, docConfigs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // DOC_CONFIGS থেকে সব possible field names + doc types বের করো
  const docTypes = docConfigs.map(c => `${c.id}: ${c.fields.map(f => f.key).join(", ")}`).join("\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a document data extractor for a Study Abroad CRM. Extract structured data from this OCR text.

Document types and their fields:
${docTypes}

OCR Text:
---
${rawText.substring(0, 4000)}
---

Instructions:
1. Identify the document type from the list above
2. Extract ALL matching fields from the text
3. Dates should be in YYYY-MM-DD format
4. Names should be in ENGLISH UPPERCASE
5. Return ONLY valid JSON, no explanation

Response format:
{"doc_type": "document_type_id", "fields": {"field_key": "value", ...}, "confidence": "high|medium|low"}`
        }],
      }),
    });

    if (!response.ok) {
      console.error("[Haiku] API error:", response.status);
      return null;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "";

    // JSON parse — Haiku response থেকে structured data বের করো
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      docType: parsed.doc_type || "unknown",
      fields: parsed.fields || {},
      confidence: parsed.confidence || "medium",
      engine: "haiku",
    };
  } catch (err) {
    console.error("[Haiku Error]", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// GET /api/ocr/credits — agency-র বর্তমান credit balance
// ═══════════════════════════════════════════════════════════════
router.get("/credits", async (req, res) => {
  try {
    const credits = await getOcrCredits(req.user.agency_id);
    res.json({ credits });
  } catch { res.json({ credits: 0 }); }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/ocr/usage — agency-র OCR usage history
// ═══════════════════════════════════════════════════════════════
router.get("/usage", async (req, res) => {
  try {
    const { data } = await supabase.from("ocr_usage")
      .select("*").eq("agency_id", req.user.agency_id)
      .order("created_at", { ascending: false }).limit(100);
    res.json(data || []);
  } catch { res.json([]); }
});

// ═══════════════════════════════════════════════════════════════
// রাউট হ্যান্ডলার — POST /api/ocr/scan
// Credit check → Google Vision OCR → Haiku AI extraction → fallback regex
// ═══════════════════════════════════════════════════════════════

router.post("/scan", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded — supported: JPEG, PNG, WebP, PDF (max 10MB)" });

  const filePath = req.file.path;

  try {
    // ── Step 0: Credit check — প্রতি scan-এ 5 credit লাগে ──
    const CREDITS_PER_SCAN = 5;
    const credits = await getOcrCredits(req.user.agency_id);
    if (credits < CREDITS_PER_SCAN) {
      return res.status(402).json({
        error: `OCR credit অপর্যাপ্ত (${credits}/${CREDITS_PER_SCAN}) — অ্যাডমিনের সাথে যোগাযোগ করুন`,
        code: "NO_CREDITS",
        credits,
        required: CREDITS_PER_SCAN,
      });
    }

    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString("base64");

    const base64SizeMB = (base64Image.length * 3 / 4) / (1024 * 1024);
    console.log(`[OCR] File: ${req.file.originalname}, Size: ${base64SizeMB.toFixed(2)}MB, Credits: ${credits}`);
    if (base64SizeMB > 8) return res.status(400).json({ error: "Image too large — max 8MB" });

    // ── Step 1: Google Vision OCR — raw text extract (ফ্রি 1000/মাস) ──
    const visionApiKey = process.env.GOOGLE_VISION_API_KEY;
    let fullText = "";

    if (visionApiKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);
        const data = await response.json();
        fullText = data.responses?.[0]?.fullTextAnnotation?.text || "";
      } catch (fetchErr) {
        clearTimeout(timeout);
        console.error("[OCR] Vision API error:", fetchErr.message);
      }
    }

    if (!fullText.trim()) {
      return res.status(400).json({ error: "No text detected — upload a clearer image" });
    }

    // ── Step 2: Claude Haiku AI extraction (primary) ──
    let result = null;
    let engine = "regex";

    if (process.env.ANTHROPIC_API_KEY) {
      result = await extractWithHaiku(fullText, DOC_CONFIGS);
      if (result && Object.keys(result.fields).length >= 3) {
        engine = "haiku";
        console.log(`[OCR] Haiku extracted ${Object.keys(result.fields).length} fields (${result.confidence})`);
      } else {
        result = null; // Haiku fail — fallback এ যাও
      }
    }

    // ── Step 3: Regex fallback — Haiku fail হলে বা API key না থাকলে ──
    if (!result) {
      const parsed = detectAndParse(fullText);
      result = {
        docType: parsed.docType,
        fields: parsed.fields,
        confidence: parsed.fields._confidence || "low",
        engine: "regex",
      };
      engine = "regex";
      console.log(`[OCR] Regex fallback: ${parsed.docType}, ${Object.keys(parsed.fields).length} fields`);
    }

    // ── Step 4: Credit deduct (5 credit/scan) + usage log ──
    const fieldsCount = Object.keys(result.fields).filter(k => !k.startsWith("_")).length;
    const remainingCredits = await deductCredit(req.user.agency_id, req.user.id, {
      docType: result.docType, engine, confidence: result.confidence,
      fieldsCount, fileName: req.file.originalname,
    });

    // ── Response ──
    res.json({
      success: true,
      raw_text: fullText,
      doc_type: result.docType,
      extracted_fields: result.fields,
      confidence: result.confidence,
      engine,
      credits_used: CREDITS_PER_SCAN,
      credits_remaining: remainingCredits,
    });

  } catch (err) {
    console.error("[OCR Error]", err.message);
    res.status(500).json({ error: "OCR processing failed: " + err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

module.exports = router;
