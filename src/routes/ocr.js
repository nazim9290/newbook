/**
 * ocr.js — Document OCR Route (ডকুমেন্ট স্ক্যান)
 *
 * Google Cloud Vision API ব্যবহার করে document image থেকে
 * English text extract করে structured fields-এ parse করে।
 *
 * সমর্থিত ডকুমেন্ট ধরন:
 *   1. Birth Certificate (জন্ম নিবন্ধন) — Paurashava, City Corp, Union Parishad
 *   2. SSC/HSC Certificate (একাডেমিক ট্রান্সক্রিপ্ট) — সব বোর্ড
 *
 * OCR text থেকে auto-detect করে কোন parser ব্যবহার করবে।
 *
 * Environment Variable প্রয়োজন:
 *   GOOGLE_VISION_API_KEY — Google Cloud Console থেকে API key নিতে হবে
 *   (Vision API enable থাকতে হবে project-এ)
 *
 * Endpoint:
 *   POST /api/ocr/scan — multipart/form-data, field name: "file"
 *
 * Supported formats: JPEG, PNG, WebP, PDF (max 10MB)
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const auth = require("../middleware/auth");

// ── Auth middleware — সব OCR endpoint-এ login লাগবে ──
router.use(auth);

// ── Temp upload directory তৈরি করো (না থাকলে) ──
const uploadDir = path.join(__dirname, "../../uploads/ocr-temp");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── File upload config — শুধু image/PDF allow ──
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // সর্বোচ্চ 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(null, false); // অনুমোদিত নয় — file reject
    }
  }
});

/**
 * POST /api/ocr/scan
 * ডকুমেন্ট image upload → Google Vision OCR → auto-detect doc type → structured fields extract
 *
 * সমর্থিত ডকুমেন্ট:
 *   - Birth Certificate (জন্ম নিবন্ধন)
 *   - SSC/HSC Certificate (একাডেমিক ট্রান্সক্রিপ্ট)
 *
 * Request: multipart/form-data, field "file" (JPEG/PNG/WebP/PDF)
 * Response: { success, raw_text, doc_type, extracted_fields, confidence }
 */
router.post("/scan", upload.single("file"), async (req, res) => {
  // ফাইল না পেলে error
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded — supported: JPEG, PNG, WebP, PDF (max 10MB)" });
  }

  const filePath = req.file.path;

  try {
    // ── ফাইল পড়ে base64-এ convert করো ──
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString("base64");

    // ── Google Vision API key check ──
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Google Vision API key not configured — set GOOGLE_VISION_API_KEY in .env"
      });
    }

    // ── Google Cloud Vision API call — TEXT_DETECTION + DOCUMENT_TEXT_DETECTION ──
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: base64Image },
            features: [
              { type: "TEXT_DETECTION" },
              { type: "DOCUMENT_TEXT_DETECTION" }
            ]
          }]
        })
      }
    );

    const data = await response.json();

    // Google API error handle
    if (data.error) {
      throw new Error(data.error.message);
    }

    // ── Full text বের করো — DOCUMENT_TEXT_DETECTION বেশি accurate ──
    const fullText = data.responses?.[0]?.fullTextAnnotation?.text || "";

    if (!fullText.trim()) {
      return res.status(400).json({
        error: "No text detected in image — please upload a clearer photo"
      });
    }

    // ── ডকুমেন্টের ধরন auto-detect করে সঠিক parser কল করো ──
    let fields;
    let detectedDocType = "unknown";

    if (/birth\s*(registration|certificate)/i.test(fullText) || /জন্ম নিবন্ধন/.test(fullText)) {
      // জন্ম নিবন্ধন সনদ
      detectedDocType = "birth_certificate";
      fields = parseBirthCertificate(fullText);
    } else if (/secondary\s*certificate|SSC|HSC|intermediate/i.test(fullText) || /academic\s*transcript/i.test(fullText)) {
      // একাডেমিক ট্রান্সক্রিপ্ট — SSC বা HSC
      detectedDocType = "academic_transcript";
      fields = parseAcademicTranscript(fullText);
    } else {
      // অচেনা ডকুমেন্ট — সব parser চেষ্টা করে সবচেয়ে ভালো result রিটার্ন
      const birthFields = parseBirthCertificate(fullText);
      const academicFields = parseAcademicTranscript(fullText);

      // কোন parser বেশি field extract করতে পেরেছে সেটা ব্যবহার করো
      const birthCount = Object.keys(birthFields).filter(k => !k.startsWith("_")).length;
      const academicCount = Object.keys(academicFields).filter(k => !k.startsWith("_")).length;

      if (academicCount > birthCount) {
        detectedDocType = "academic_transcript";
        fields = academicFields;
      } else {
        detectedDocType = "birth_certificate";
        fields = birthFields;
      }
    }

    res.json({
      success: true,
      raw_text: fullText,
      doc_type: detectedDocType,
      extracted_fields: fields,
      confidence: fields._confidence || "medium"
    });

  } catch (err) {
    console.error("[OCR Error]", err.message);
    res.status(500).json({ error: "OCR processing failed: " + err.message });
  } finally {
    // ── Temp file মুছে ফেলো — storage জমা হবে না ──
    try { fs.unlinkSync(filePath); } catch {}
  }
});

// ═══════════════════════════════════════════════════════════
// parseBirthCertificate — OCR text থেকে structured fields extract
// ═══════════════════════════════════════════════════════════
//
// বাংলাদেশের ৩ ধরনের birth certificate handle করে:
//   1. Paurashava (পৌরসভা)
//   2. City Corporation (সিটি কর্পোরেশন)
//   3. Union Parishad (ইউনিয়ন পরিষদ)
//
// শুধু English text extract করে — Bengali text ignore করে।

/**
 * OCR text থেকে birth certificate-এর fields parse করো
 * @param {string} text — Google Vision থেকে পাওয়া raw text
 * @returns {object} — parsed fields with _confidence score
 */
function parseBirthCertificate(text) {
  const fields = {};
  const fullText = text;

  // ── Template type detect করো ──
  if (/paurashava/i.test(fullText) || /পৌরসভা/.test(fullText)) {
    fields.template_type = "Paurashava";
  } else if (/city corporation/i.test(fullText) || /সিটি কর্পোরেশন/.test(fullText)) {
    fields.template_type = "City Corporation";
  } else if (/union parishad/i.test(fullText) || /ইউনিয়ন পরিষদ/.test(fullText)) {
    fields.template_type = "Union Parishad";
  }

  // ── Birth Registration Number — ১৭ ডিজিটের নম্বর ──
  const regNoMatch = fullText.match(/\b(\d{17})\b/);
  if (regNoMatch) fields.birth_reg_no = regNoMatch[1];

  // ── Register No — ছোট সংখ্যা (e.g. "2 5" বা "25") ──
  const registerMatch = fullText.match(/Register\s*No[:\s]*(\d[\s\d]*\d)/i);
  if (registerMatch) fields.register_no = registerMatch[1].replace(/\s/g, "");

  // ── Name — "Name" label-এর পরের English text ──
  const nameMatch = fullText.match(/(?:^|\n)\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (nameMatch) fields.name_en = nameMatch[1].trim();

  // ── Date of Birth — DD/MM/YYYY বা DD-MM-YYYY format ──
  const dobMatch = fullText.match(/Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
  if (dobMatch) {
    const parsed = parseDateToISO(dobMatch[1]);
    if (parsed) fields.dob = parsed;
  }

  // ── Date of Birth in Words — "In Word" বা "in words" label ──
  const dobWordMatch = fullText.match(
    /(?:In\s*Word|in\s*words?)\s*[:\-]?\s*([A-Za-z\s,]+?(?:Thousand|Hundred)[A-Za-z\s]*)/i
  );
  if (dobWordMatch) fields.dob_in_word = dobWordMatch[1].trim();

  // ── Sex — Male/Female/Other ──
  const sexMatch = fullText.match(/Sex\s*[:\-]?\s*(Male|Female|Other)/i);
  if (sexMatch) {
    fields.sex = sexMatch[1].charAt(0).toUpperCase() + sexMatch[1].slice(1).toLowerCase();
  }

  // ── Place of Birth — জন্মস্থান ──
  const placeMatch = fullText.match(/Place\s*of\s*Birth\s*[:\-]?\s*([A-Za-z\s,.\-]+?)(?:\n|$)/i);
  if (placeMatch) fields.birth_place = placeMatch[1].trim();

  // ── Father's Name — পিতার নাম ──
  const fatherMatch = fullText.match(/Father\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/i);
  if (fatherMatch) fields.father_name = fatherMatch[1].trim();

  // ── Father's Nationality — পিতার জাতীয়তা ──
  const fatherNatMatch = fullText.match(/Father[''\u2019]?s?\s*Nationality\s*[:\-]?\s*([A-Za-z]+)/i);
  if (fatherNatMatch) fields.father_nationality = fatherNatMatch[1].trim();

  // ── Mother's Name — মাতার নাম ──
  const motherMatch = fullText.match(/Mother\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/i);
  if (motherMatch) fields.mother_name = motherMatch[1].trim();

  // ── Mother's Nationality — মাতার জাতীয়তা ──
  const motherNatMatch = fullText.match(/Mother[''\u2019]?s?\s*Nationality\s*[:\-]?\s*([A-Za-z]+)/i);
  if (motherNatMatch) fields.mother_nationality = motherNatMatch[1].trim();

  // ── Permanent Address — স্থায়ী ঠিকানা ──
  const addrMatch = fullText.match(/Permanent\s*Address\s*[:\-]?\s*([A-Za-z\d\s,.\-\/]+?)(?:\n|Date|$)/i);
  if (addrMatch) fields.permanent_address = addrMatch[1].trim().replace(/\s+/g, " ");

  // ── Date of Registration — নিবন্ধনের তারিখ ──
  const regDateMatch = fullText.match(
    /Date\s*of\s*Registration\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i
  );
  if (regDateMatch) {
    const parsed = parseDateToISO(regDateMatch[1]);
    if (parsed) fields.reg_date = parsed;
  }

  // ── Date of Issue — ইস্যু তারিখ ──
  const issueDateMatch = fullText.match(
    /Date\s*of\s*Issu(?:e|ance)\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i
  );
  if (issueDateMatch) {
    const parsed = parseDateToISO(issueDateMatch[1]);
    if (parsed) fields.issue_date = parsed;
  }

  // ═══════════════════════════════════════════════════════
  // Authority-specific fields — template অনুযায়ী extra info
  // ═══════════════════════════════════════════════════════

  // ── Paurashava নাম ──
  const paurMatch = fullText.match(/(\w+)\s*Paurashava/i);
  if (paurMatch) fields.paurashava_name = paurMatch[1] + " Paurashava";

  // ── Zone (City Corporation-এ থাকে) ──
  const zoneMatch = fullText.match(/Zone[:\-\s]*(\d+)/i);
  if (zoneMatch) fields.zone = zoneMatch[1];

  // ── City Corporation নাম ──
  const cityCorpMatch = fullText.match(/([\w\s]+)\s*(?:City\s*Corporation)/i);
  if (cityCorpMatch) fields.city_corp_name = cityCorpMatch[1].trim() + " City Corporation";

  // ── Union Parishad নাম ──
  const unionMatch = fullText.match(/([\w\s]+)\s*Union\s*Parishad/i);
  if (unionMatch) fields.union_name = unionMatch[1].trim() + " Union Parishad";

  // ── Upazila নাম ──
  const upazilaMatch = fullText.match(/(?:Upazila|Upozila)[:\-\s]*([\w\s]+?)(?:,|\n|$)/i);
  if (upazilaMatch) fields.upazila_name = upazilaMatch[1].trim();

  // ── District নাম ──
  const distMatch = fullText.match(/Dist(?:rict)?[:\-.\s]*([\w\s]+?)(?:,|\n|$)/i);
  if (distMatch) fields.district_name = distMatch[1].trim();

  // ═══════════════════════════════════════════════════════
  // Confidence score — কতগুলো key field পাওয়া গেছে তার ভিত্তিতে
  // ═══════════════════════════════════════════════════════
  const keyFields = ["birth_reg_no", "name_en", "dob", "father_name", "mother_name"];
  const found = keyFields.filter(k => fields[k]).length;
  fields._confidence = found >= 4 ? "high" : found >= 2 ? "medium" : "low";

  return fields;
}

// ═══════════════════════════════════════════════════════════
// parseAcademicTranscript — SSC/HSC সার্টিফিকেট থেকে fields extract
// ═══════════════════════════════════════════════════════════
//
// বাংলাদেশের শিক্ষা বোর্ডের SSC ও HSC সার্টিফিকেট parse করে।
// বোর্ডের নাম, পরীক্ষার বছর, শিক্ষার্থীর তথ্য, রেজাল্ট,
// এবং বিষয়ভিত্তিক গ্রেড ও পয়েন্ট extract করে।
//
// শুধু English text extract করে — Bengali text ignore করে।

/**
 * OCR text থেকে SSC/HSC সার্টিফিকেটের fields parse করো
 * @param {string} text — Google Vision থেকে পাওয়া raw text
 * @returns {object} — parsed fields with _confidence ও _exam_type
 */
function parseAcademicTranscript(text) {
  const fields = {};

  // ── পরীক্ষার ধরন detect — SSC নাকি HSC ──
  if (/higher\s*secondary/i.test(text) || /HSC/i.test(text)) {
    fields._exam_type = "HSC";
  } else if (/secondary\s*school/i.test(text) || /SSC/i.test(text)) {
    fields._exam_type = "SSC";
  }

  // ── বোর্ডের নাম — "Board of Intermediate and Secondary Education, Dhaka" ──
  const boardMatch = text.match(/Board\s*of\s*([\w\s&]+?),\s*([\w]+)/i);
  if (boardMatch) fields.board_name = boardMatch[0].trim();

  // ── পরীক্ষার বছর — "Examination, 2021" বা "Examination in ... 2021" ──
  const yearMatch = text.match(/Examination[,\s]*(\d{4})/i);
  if (yearMatch) fields.exam_year = yearMatch[1];

  // ── সিরিয়াল নম্বর — "Serial No. DBHT 21 0163916" ──
  const serialMatch = text.match(/Serial\s*No\.?\s*:?\s*([\w\s]+\d{5,})/i);
  if (serialMatch) fields.serial_no = serialMatch[1].trim();

  // ── শিক্ষার্থীর নাম — "Name of Student : Rakib Miah" বা "Name:" ──
  const nameMatch = text.match(/Name\s*(?:of\s*Student)?\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (nameMatch) fields.name_en = nameMatch[1].trim();

  // ── পিতার নাম ──
  const fatherMatch = text.match(/Father[''\u2019]?s?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (fatherMatch) fields.father_name = fatherMatch[1].trim();

  // ── মাতার নাম ──
  const motherMatch = text.match(/Mother[''\u2019]?s?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (motherMatch) fields.mother_name = motherMatch[1].trim();

  // ── প্রতিষ্ঠানের নাম — "Name of Institution : ..." ──
  const instMatch = text.match(/(?:Name\s*of\s*)?Institution\s*[:\-]\s*(.+?)(?:\n|$)/im);
  if (instMatch) fields.institution = instMatch[1].trim();

  // ── পরীক্ষার কেন্দ্র ──
  const centreMatch = text.match(/(?:Name\s*of\s*)?Centre\s*[:\-]\s*(.+?)(?:\n|$)/im);
  if (centreMatch) fields.centre = centreMatch[1].trim();

  // ── রোল নম্বর — "Roll No. : 13 52 17" ──
  const rollMatch = text.match(/Roll\s*No\.?\s*[:\-]?\s*([\d\s]+?)(?:\n|Registration|$)/im);
  if (rollMatch) fields.roll_no = rollMatch[1].trim();

  // ── রেজিস্ট্রেশন নম্বর — "Registration No. : 1610737002/2019-20" ──
  const regMatch = text.match(/Registration\s*No\.?\s*[:\-]?\s*([\d\/\-]+)/im);
  if (regMatch) fields.registration_no = regMatch[1].trim();

  // ── গ্রুপ/বিভাগ — Science, Commerce, Arts/Humanities ──
  const groupMatch = text.match(/Group\s*[:\-]?\s*(Science|Commerce|Arts|Humanities)/im);
  if (groupMatch) fields.group = groupMatch[1].trim();

  // ── শিক্ষার্থীর ধরন — Regular, Irregular, Private ──
  const typeMatch = text.match(/Type\s*(?:of\s*Student)?\s*[:\-]?\s*(Regular|Irregular|Private)/im);
  if (typeMatch) fields.student_type = typeMatch[1].trim();

  // ── GPA extract — "4.58" বা "5.00" pattern ──
  // প্রথমে explicit GPA label চেক করো
  const gpaExplicit = text.match(/G\.?P\.?A\.?\s*[:\-]?\s*(\d\.\d{2})/i);
  if (gpaExplicit) {
    fields.gpa = gpaExplicit[1];
  }

  // সব \d.\dd pattern বের করো — প্রথমটা additional ছাড়া, দ্বিতীয়টা additional সহ
  const gpaMatches = text.match(/\b(\d\.\d{2})\b/g);
  if (gpaMatches && gpaMatches.length >= 1) {
    if (!fields.gpa) fields.gpa = gpaMatches[0];
    if (gpaMatches.length >= 2 && gpaMatches[1] !== gpaMatches[0]) {
      fields.gpa_with_additional = gpaMatches[1];
    }
  }

  // ── ফলাফল প্রকাশের তারিখ — "13 February, 2022" ──
  const dateMatch = text.match(/(?:Date\s*of\s*Publication|Date\s*of\s*Results?)\s*[:\-]?\s*(\d{1,2}\s+\w+,?\s*\d{4})/im);
  if (dateMatch) fields.result_date = dateMatch[1].trim();

  // ═══════════════════════════════════════════════════════
  // বিষয়ভিত্তিক ফলাফল — টেবিল row parse
  // ═══════════════════════════════════════════════════════
  // Pattern: "1  Bangla  A  4" বা "English  A-  3.5"
  const subjectPattern = /\d?\s*([\w\s&]+?)\s+(A\+|A\-?|B\+?|C\+?|D|F)\s+(\d\.?\d*)/g;
  const subjects = [];
  let match;
  while ((match = subjectPattern.exec(text)) !== null) {
    const subjectName = match[1].trim();
    // ভুল match ফিল্টার — subject name ২ অক্ষরের বেশি এবং ৫০ এর কম হতে হবে
    if (subjectName.length > 2 && subjectName.length < 50 && !/GPA|Point|Grade|Name|Subject/i.test(subjectName)) {
      subjects.push({
        Subject: subjectName,
        Grade: match[2],
        Point: match[3]
      });
    }
  }

  // বিষয়গুলো flattened Member-style fields-এ store — existing pattern compatible
  subjects.forEach((s, i) => {
    fields[`Member${i + 1}_Subject`] = s.Subject;
    fields[`Member${i + 1}_Grade`] = s.Grade;
    fields[`Member${i + 1}_Point`] = s.Point;
  });

  // ═══════════════════════════════════════════════════════
  // Confidence score — key fields কতগুলো পাওয়া গেছে
  // ═══════════════════════════════════════════════════════
  const keyFields = ["name_en", "roll_no", "gpa", "exam_year"];
  const found = keyFields.filter(k => fields[k]).length;
  fields._confidence = found >= 3 ? "high" : found >= 2 ? "medium" : "low";

  return fields;
}

/**
 * DD/MM/YYYY বা DD-MM-YYYY → ISO YYYY-MM-DD format-এ convert করো
 * 2-digit year handle: >50 → 19xx, <=50 → 20xx
 *
 * @param {string} dateStr — "25/12/1998" বা "25-12-98"
 * @returns {string|null} — "1998-12-25" বা null
 */
function parseDateToISO(dateStr) {
  const parts = dateStr.split(/[\/-]/);
  if (parts.length !== 3) return null;

  let [d, m, y] = parts;
  // 2-digit year → full year
  if (y.length === 2) {
    y = (parseInt(y) > 50 ? "19" : "20") + y;
  }

  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

module.exports = router;
