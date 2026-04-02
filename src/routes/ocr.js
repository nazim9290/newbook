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

// ── Upload config ──
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

/** Date parser — "08 Jun 1978", "06/08/2023", "13 February, 2022" → YYYY-MM-DD */
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

// Shared patterns — reusable across doc types
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
  // ── 0. Studentship Certificate (ছাত্রত্ব সনদ) ──
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

  // ── 0a. Learning Certificate (学習証明書) — must be before Proficiency ──
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

  // ── 0b. Language Proficiency Certificate (日本語能力証明書) ──
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

  // ── 0c. Passport (Bangladesh MRP) ──
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
      // MRZ থেকে passport number extract (fallback)
      if (!fields.passport_number) {
        const mrz = text.match(/P<BGD([A-Z]+)<<([A-Z]+)/);
        if (mrz) { fields.surname = mrz[1]; fields.given_name = mrz[2]; }
        const mrzNum = text.match(/([A-Z]\d{7,8})BGD/);
        if (mrzNum) fields.passport_number = mrzNum[1];
      }
    },
    confidence: ["passport_number", "surname", "given_name", "dob"],
  },

  // ── 1. Family Relation Certificate ──
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
      // Family members table — "01 SIFAT SHEIKH MYSELF 07-10-2001"
      { key: "members", type: "table", pattern: /\d{1,2}\s+([A-Z][A-Za-z\s.]+?)\s+(MYSELF|FATHER|MOTHER|BROTHER|SISTER|SPOUSE|SON|DAUGHTER|UNCLE|AUNT)\s+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/gi, columns: ["Name", "Relation", "DOB"] },
    ],
    confidence: ["applicant_name", "father_name"],
  },

  // ── 1. National ID Card (Old + Smart Card) ──
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

  // ── 2. Trade License ──
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
      // Fee table
      { key: "fees", type: "table", pattern: /([\w\/\s]+?(?:Fee|Tax|VAT|Surcharge))\s*[:\-]?\s*([\d,.]+)/gi, columns: ["Item", "Amount"] },
    ],
    confidence: ["license_no", "business_name", "owner_name"],
  },

  // ── 3. TIN Certificate ──
  {
    id: "tin_certificate",
    detect: /TIN|Taxpayer[\s\S]{0,20}Identification[\s\S]{0,20}Number/i,
    reject: /birth/i, // TIN text-এ "birth" থাকলে Birth Cert হতে পারে
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

  // ── 4. Income Tax Certificate ──
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
      // Tax payments table
      { key: "tax_payments", type: "table", pattern: /(\d{4}[-–]\d{4}).*?(?:paid\s*)?Tk\.?\s*([\d,]+)/gi, columns: ["Year", "Amount"] },
    ],
    confidence: ["etin", "name_en"],
  },

  // ── 5. Annual Income Certificate ──
  {
    id: "annual_income_certificate",
    detect: /Annual\s*In[oc]ome\s*Certificate/i,
    fields: [
      { key: "name_en", patterns: [/Name\s*(?:Mr\/Mrs\/M\/S)?\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im] },
      { key: "father_name", patterns: P.father },
      { key: "mother_name", patterns: P.mother },
      { key: "permanent_address", patterns: P.permAddr },
      { key: "present_address", patterns: P.curAddr },
      // Income table
      { key: "income", type: "table", pattern: /\d+\s+([\w\s]+?)\s*\((\d{4}[-–]\d{4})\)\s*([\d,]+)/gi, columns: ["Source", "Year", "Amount"] },
    ],
    confidence: ["name_en"],
  },

  // ── 6. Birth Certificate — Bengali+English mixed OCR handle ──
  {
    id: "birth_certificate",
    detect: /birth\s*(registration|certificate)|জন্ম\s*নিবন্ধন/i,
    fields: [
      // 17-digit registration number
      { key: "birth_reg_no", patterns: [/\b(\d{17})\b/, /Registration\s*Number\s*[\s\S]*?(\d{17})/i] },
      { key: "register_no", patterns: [/Register\s*No[:\s]*(\d[\s\d]*\d)/i], type: "number" },
      // Name — "Name : Sifat Sheikh" or "Name\nSifat Sheikh" — Bengali text আগে থাকতে পারে
      { key: "name_en", patterns: [
        /Name\s*[:\-]\s*([A-Z][A-Za-z\s.]+?)(?:\n|মাতা|Mother|পিতা|Father|$)/im,
        /Name\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/im,
      ] },
      // DOB — multiple formats
      { key: "dob", patterns: [
        /Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
        /Birth\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
      ], type: "date" },
      { key: "dob_in_word", patterns: [
        /[Ii]n\s*[Ww]ord\s*[:\-]?\s*([A-Z][A-Za-z\s,]+?(?:Thousand|Hundred|One|Two|Three|Four|Five)[A-Za-z\s]*)/i,
      ] },
      { key: "sex", patterns: [/Sex\s*[:\-]?\s*(Male|Female|Other)/i] },
      // Place of Birth — mixed text
      { key: "birth_place", patterns: [
        /Place\s*of\s*Birth\s*[:\-]?\s*([A-Za-z][A-Za-z\s,.\-]+?)(?:\n|স্থায়ী|Permanent|$)/i,
      ] },
      // Father — "Father : Karim Sheikh" — Bengali label আগে থাকতে পারে
      { key: "father_name", patterns: [
        /Father\s*[:\-]\s*([A-Z][A-Za-z\s.]+?)(?:\n|Nationality|জাতীয়তা|$)/im,
        /Father\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/im,
      ] },
      { key: "father_nationality", patterns: [
        /(?:Father['']?s?\s*)?Nationality\s*[:\-]?\s*(Bangladeshi|[A-Z][a-z]+)/i,
      ] },
      // Mother
      { key: "mother_name", patterns: [
        /Mother\s*[:\-]\s*([A-Z][A-Za-z\s.]+?)(?:\n|Nationality|জাতীয়তা|$)/im,
        /Mother\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/im,
      ] },
      { key: "mother_nationality", patterns: [
        /Mother['']?s?\s*Nationality\s*[:\-]?\s*(Bangladeshi|[A-Z][a-z]+)/i,
      ] },
      // Permanent Address — multi-word with commas
      { key: "permanent_address", patterns: [
        /Permanent\s*Address\s*[:\-]?\s*([A-Za-z][A-Za-z\d\s,.\-\/]+?)(?:\n\n|\nDate|\nThis|$)/ims,
      ] },
      // Dates
      { key: "reg_date", patterns: [/Date\s*of\s*Registration\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "issue_date", patterns: [/Date\s*of\s*Issu(?:e|ance)\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      // Authority — Union/Paurashava/City Corp
      { key: "paurashava_name", patterns: [/([\w\s]+?)\s*Paurashava/i] },
      { key: "zone", patterns: [/Zone[:\-\s]*(\d+)/i] },
      { key: "city_corp_name", patterns: [/([\w\s]+?)\s*City\s*Corporation/i] },
      { key: "union_name", patterns: [/([\w\s]+?)\s*Union\s*Parishad/i] },
      { key: "upazila_name", patterns: [/(?:Upazila|Sadar)[,:\-\s]*([\w\s]+?)(?:,|\n|$)/i] },
      { key: "district_name", patterns: [/(?:Dist(?:rict)?|Munshiganj|Dhaka|Chittagong|Sylhet|Barishal|Rajshahi|Rangpur|Khulna|Mymensingh)[:\-.\s]*([\w\s]*?)(?:,|\n|$)/i] },
    ],
    postProcess: (fields, text) => {
      // Template type auto-detect
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

  // ── 7. SSC/HSC Academic Transcript ──
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
      // Subject results table
      { key: "subjects", type: "table", pattern: /\d?\s*([\w\s&]{3,40}?)\s+(A\+|A\-?|B\+?|C\+?|D|F)\s+(\d\.?\d*)/g, columns: ["Subject", "Grade", "Point"] },
    ],
    postProcess: (fields, text) => {
      // SSC or HSC detect
      if (/higher\s*secondary|HSC/i.test(text)) fields._exam_type = "HSC";
      else if (/secondary\s*school|SSC/i.test(text)) fields._exam_type = "SSC";

      // GPA with additional — second GPA match
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
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════

router.post("/scan", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded — supported: JPEG, PNG, WebP, PDF (max 10MB)" });

  const filePath = req.file.path;

  try {
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString("base64");

    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GOOGLE_VISION_API_KEY not configured" });

    const base64SizeMB = (base64Image.length * 3 / 4) / (1024 * 1024);
    console.log(`[OCR] File: ${req.file.originalname}, Size: ${base64SizeMB.toFixed(2)}MB`);
    if (base64SizeMB > 8) return res.status(400).json({ error: "Image too large — max 8MB" });

    // Google Vision API call
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
          signal: controller.signal,
        }
      );
    } catch (fetchErr) {
      clearTimeout(timeout);
      console.error("[OCR] Vision API error:", fetchErr.cause?.code || fetchErr.message);
      return res.status(502).json({ error: "Google Vision API connection failed — try again" });
    }
    clearTimeout(timeout);

    const data = await response.json();
    if (data.error) { console.error("[OCR] API error:", data.error.message); throw new Error(data.error.message); }

    const fullText = data.responses?.[0]?.fullTextAnnotation?.text || "";
    console.log("[OCR] Raw text (full):", fullText);
    if (!fullText.trim()) return res.status(400).json({ error: "No text detected — upload a clearer image" });

    // Auto-detect + parse
    const { docType, fields } = detectAndParse(fullText);

    res.json({
      success: true,
      raw_text: fullText,
      doc_type: docType,
      extracted_fields: fields,
      confidence: fields._confidence || "low",
    });

  } catch (err) {
    console.error("[OCR Error]", err.message);
    res.status(500).json({ error: "OCR processing failed: " + err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

module.exports = router;
