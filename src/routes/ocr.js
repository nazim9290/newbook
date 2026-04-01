/**
 * ocr.js — Document OCR Route (ডকুমেন্ট স্ক্যান)
 *
 * Google Cloud Vision API ব্যবহার করে document image থেকে
 * English text extract করে structured fields-এ parse করে।
 *
 * সমর্থিত ডকুমেন্ট ধরন:
 *   1. Birth Certificate (জন্ম নিবন্ধন) — Paurashava, City Corp, Union Parishad
 *   2. SSC/HSC Certificate (একাডেমিক ট্রান্সক্রিপ্ট) — সব বোর্ড
 *   3. TIN Certificate (টিআইএন সনদ) — sponsor document
 *   4. Income Tax Certificate (আয়কর সনদ) — sponsor document
 *   5. Annual Income Certificate (বার্ষিক আয়ের সনদ) — sponsor document
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
 *   - TIN Certificate (টিআইএন সনদ)
 *   - Income Tax Certificate (আয়কর সনদ)
 *   - Annual Income Certificate (বার্ষিক আয়ের সনদ)
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

    // ── Image size check — base64 করলে ৩৩% বড় হয়, Google limit 10MB ──
    const base64SizeMB = (base64Image.length * 3 / 4) / (1024 * 1024);
    console.log(`[OCR] File: ${req.file.originalname}, Size: ${base64SizeMB.toFixed(2)}MB`);

    if (base64SizeMB > 8) {
      return res.status(400).json({ error: "Image too large — max 8MB. Please compress or resize." });
    }

    // ── Google Cloud Vision API call — DOCUMENT_TEXT_DETECTION only (বেশি accurate) ──
    const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    const visionBody = JSON.stringify({
      requests: [{
        image: { content: base64Image },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }]
      }]
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    let response;
    try {
      response = await fetch(visionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: visionBody,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      console.error("[OCR] Google Vision fetch error:", fetchErr.cause?.code || fetchErr.message);
      return res.status(502).json({ error: "Google Vision API connection failed — try again" });
    }
    clearTimeout(timeout);

    const data = await response.json();

    // Google API error handle
    if (data.error) {
      console.error("[OCR] Google API error:", data.error.message);
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
    // Detection order: সবচেয়ে specific আগে — sponsor docs → birth cert → academic → fallback
    let fields;
    let detectedDocType = "unknown";

    if (/Trade\s*License|E-Trade/i.test(fullText)) {
      // ট্রেড লাইসেন্স — sponsor document
      detectedDocType = "trade_license";
      fields = parseTradeLicense(fullText);
    } else if ((/TIN|Taxpayer[\s\S]*?Identification[\s\S]*?Number/i.test(fullText)) && !/birth/i.test(fullText)) {
      // টিআইএন সনদ — sponsor document
      detectedDocType = "tin_certificate";
      fields = parseSponsorDocument(fullText, "tin");
    } else if (/Income\s*Tax\s*Certificate/i.test(fullText)) {
      // আয়কর সনদ — sponsor document
      detectedDocType = "income_tax_certificate";
      fields = parseSponsorDocument(fullText, "income_tax");
    } else if (/Annual\s*In[oc]ome\s*Certificate/i.test(fullText)) {
      // বার্ষিক আয়ের সনদ — sponsor document
      detectedDocType = "annual_income_certificate";
      fields = parseSponsorDocument(fullText, "annual_income");
    } else if (/birth\s*(registration|certificate)/i.test(fullText) || /জন্ম নিবন্ধন/.test(fullText)) {
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
      const sponsorFields = parseSponsorDocument(fullText, "tin");
      const tradeFields = parseTradeLicense(fullText);

      // কোন parser বেশি field extract করতে পেরেছে সেটা ব্যবহার করো
      const birthCount = Object.keys(birthFields).filter(k => !k.startsWith("_")).length;
      const academicCount = Object.keys(academicFields).filter(k => !k.startsWith("_")).length;
      const sponsorCount = Object.keys(sponsorFields).filter(k => !k.startsWith("_")).length;
      const tradeCount = Object.keys(tradeFields).filter(k => !k.startsWith("_")).length;

      const maxCount = Math.max(birthCount, academicCount, sponsorCount, tradeCount);
      if (tradeCount === maxCount) {
        detectedDocType = "trade_license";
        fields = tradeFields;
      } else if (sponsorCount === maxCount) {
        detectedDocType = "tin_certificate";
        fields = sponsorFields;
      } else if (academicCount === maxCount) {
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

// ═══════════════════════════════════════════════════════════
// parseSponsorDocument — Sponsor ডকুমেন্ট (TIN/Income Tax/Annual Income) parse
// ═══════════════════════════════════════════════════════════
//
// তিন ধরনের sponsor ডকুমেন্ট handle করে:
//   1. TIN Certificate (টিআইএন সনদ)
//   2. Income Tax Certificate (আয়কর সনদ)
//   3. Annual Income Certificate (বার্ষিক আয়ের সনদ)
//
// শুধু English text extract করে — Japanese (_jp) fields ম্যানুয়াল এন্ট্রি।

/**
 * OCR text থেকে sponsor document-এর fields parse করো
 * @param {string} text — Google Vision থেকে পাওয়া raw text
 * @param {string} type — "tin" | "income_tax" | "annual_income"
 * @returns {object} — parsed fields with _confidence score
 */
function parseSponsorDocument(text, type) {
  const fields = {};

  // ── TIN / e-TIN নম্বর — ১২ ডিজিট ──
  const tinMatch = text.match(/(?:TIN|e-TIN|eTIN)\s*[:\-]?\s*(\d{12})/i);
  if (tinMatch) {
    fields.tin_number = tinMatch[1];
    fields.etin = tinMatch[1];
  }

  // ── নাম — "Name Mr/Mrs" বা "Name :" pattern ──
  const nameMatch = text.match(/(?:Name\s*(?:Mr\/Mrs\/M\/S)?)\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (nameMatch) fields.name_en = nameMatch[1].trim();

  // ── পিতা/স্বামীর নাম ──
  const fatherMatch = text.match(/Father['\u2018\u2019']?s?(?:\/Husband['\u2018\u2019']?s?)?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (fatherMatch) fields.father_name = fatherMatch[1].trim();

  // ── মাতার নাম ──
  const motherMatch = text.match(/Mother['\u2018\u2019']?s?\s*Name\s*[:\-]\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (motherMatch) fields.mother_name = motherMatch[1].trim();

  // ── বর্তমান/Present ঠিকানা ──
  const currentAddrMatch = text.match(/(?:Current|Present)\s*Address\s*[:\-]\s*(.+?)(?:\n(?:\d|[A-Z])|$)/ims);
  if (currentAddrMatch) {
    fields.current_address = currentAddrMatch[1].replace(/\n/g, ", ").replace(/\s+/g, " ").trim();
    fields.present_address = fields.current_address;
  }

  // ── স্থায়ী ঠিকানা ──
  const permAddrMatch = text.match(/Permanent\s*Address(?:\/Registered)?\s*[:\-]\s*(.+?)(?:\n(?:\d|[A-Z])|$)/ims);
  if (permAddrMatch) {
    fields.permanent_address = permAddrMatch[1].replace(/\n/g, ", ").replace(/\s+/g, " ").trim();
  }

  // ── কর সার্কেল ──
  const circleMatch = text.match(/(?:Taxes?\s*)?Circle[:\-\s]*(\d+)/i);
  if (circleMatch) fields.taxes_circle = circleMatch[1];

  // ── কর জোন ──
  const zoneMatch = text.match(/(?:Taxes?\s*)?Zone[:\-\s]*(\d+)/i);
  if (zoneMatch) fields.taxes_zone = zoneMatch[1];

  // ── স্ট্যাটাস — Individual/Company/Firm ──
  const statusMatch = text.match(/Status\s*[:\-]\s*(Individual|Company|Firm)/i);
  if (statusMatch) fields.status = statusMatch[1];

  // ═══════════════════════════════════════════════════════
  // TIN-specific fields — ইস্যু তারিখ, পূর্বের TIN
  // ═══════════════════════════════════════════════════════
  if (type === "tin") {
    // ইস্যু তারিখ — "Date : January 15, 2023" pattern
    const dateMatch = text.match(/Date\s*[:\-]\s*(\w+\s+\d{1,2},?\s*\d{4})/i);
    if (dateMatch) fields.issue_date = dateMatch[1].trim();

    // পূর্বের TIN নম্বর
    const prevTinMatch = text.match(/Previous\s*TIN\s*[:\-]\s*(.+?)(?:\n|$)/i);
    if (prevTinMatch) fields.previous_tin = prevTinMatch[1].trim();
  }

  // ═══════════════════════════════════════════════════════
  // Income Tax-specific — বছরভিত্তিক কর পরিশোধের তথ্য
  // ═══════════════════════════════════════════════════════
  if (type === "income_tax") {
    // Pattern: "for the years of 2021-2022 paid Tk. 355,181"
    const taxPattern = /(\d{4}[-\u2013]\d{4}).*?(?:paid\s*)?Tk\.?\s*([\d,]+)/gi;
    let match;
    let idx = 1;
    while ((match = taxPattern.exec(text)) !== null) {
      fields[`Member${idx}_Year`] = match[1];
      fields[`Member${idx}_Amount`] = match[2].replace(/,/g, "");
      idx++;
    }

    // ব্যবসা শনাক্তকরণ নম্বর
    const binMatch = text.match(/(?:Business\s*Identification|BIN)\s*(?:Number|No\.?)?\s*[:\-]\s*([\w\-]+)/i);
    if (binMatch) fields.business_id = binMatch[1].trim();
  }

  // ═══════════════════════════════════════════════════════
  // Annual Income-specific — বছরভিত্তিক আয়ের টেবিল
  // ═══════════════════════════════════════════════════════
  if (type === "annual_income") {
    // Pattern: "01  Business (2021-2022)  2,367,876 Tk."
    const incomePattern = /\d+\s+([\w\s]+?)\s*\((\d{4}[-\u2013]\d{4})\)\s*([\d,]+)/gi;
    let match;
    let idx = 1;
    while ((match = incomePattern.exec(text)) !== null) {
      fields[`Member${idx}_Source`] = match[1].trim();
      fields[`Member${idx}_Year`] = match[2];
      fields[`Member${idx}_Amount`] = match[3].replace(/,/g, "");
      idx++;
    }

    // Fallback — "Assessment of the Year 2021-2022, 2022-2023" থেকে শুধু year extract
    const yearsMatch = text.match(/(?:Assessment|Year)[^\n]*?((?:\d{4}[-\u2013]\d{4}[,\s]*)+)/i);
    if (yearsMatch && !fields.Member1_Year) {
      const years = yearsMatch[1].match(/\d{4}[-\u2013]\d{4}/g) || [];
      years.forEach((y, i) => {
        if (!fields[`Member${i + 1}_Year`]) fields[`Member${i + 1}_Year`] = y;
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  // Confidence score — key fields কতগুলো পাওয়া গেছে
  // ═══════════════════════════════════════════════════════
  const keyFields = type === "tin"
    ? ["tin_number", "name_en"]
    : ["name_en", "Member1_Amount"];
  const found = keyFields.filter(k => fields[k]).length;
  fields._confidence = found >= 2 ? "high" : found >= 1 ? "medium" : "low";

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

/**
 * parseTradeLicense — ট্রেড লাইসেন্স (E-Trade License / City Corporation)
 * License No, Business Name, Owner, Address, Fees extract করে
 */
function parseTradeLicense(text) {
  const fields = {};

  // License No — "License No : TRAD/009657/2023"
  const licenseMatch = text.match(/License\s*No\s*[:\-]?\s*([\w\/\-]+)/i);
  if (licenseMatch) fields.license_no = licenseMatch[1].trim();

  // Issue Date — "Issue Date : 06/08/2023"
  const issueDateMatch = text.match(/Issue\s*Date\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i);
  if (issueDateMatch) {
    const parts = issueDateMatch[1].split(/[\/-]/);
    if (parts.length === 3) {
      let [d, m, y] = parts;
      if (y.length === 2) y = "20" + y;
      fields.issue_date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }

  // Valid Upto — "Valid Upto 31th July 2024" or similar
  const validMatch = text.match(/Valid\s*(?:Upto?|Until)\s*(\d{1,2}\s*\w+\s*\w*\s*\d{4})/i);
  if (validMatch) fields.valid_upto = validMatch[1].trim();

  // Financial Year — "Financial Year : 2023-2024"
  const fyMatch = text.match(/Financial\s*Year\s*[:\-]?\s*([\d\-\/]+)/i);
  if (fyMatch) fields.financial_year = fyMatch[1].trim();

  // Issuing Authority — "Dhaka South City Corporation" etc
  const authorityMatch = text.match(/([\w\s]+City\s*Corporation|[\w\s]+Paurashava|[\w\s]+Union\s*Parishad)/i);
  if (authorityMatch) fields.issuing_authority = authorityMatch[1].trim();

  // Business Name — "Business Name : M/S Howlader Enterprise"
  const bizNameMatch = text.match(/Business\s*Name\s*[:\-]?\s*(.+?)(?:\n|$)/im);
  if (bizNameMatch) fields.business_name = bizNameMatch[1].trim();

  // Business Type
  const bizTypeMatch = text.match(/Business\s*Type\s*[:\-]?\s*(.+?)(?:\n|$)/im);
  if (bizTypeMatch) fields.business_type = bizTypeMatch[1].trim();

  // Business Category
  const bizCatMatch = text.match(/Business\s*Category\s*[:\-]?\s*(.+?)(?:\n|$)/im);
  if (bizCatMatch) fields.business_category = bizCatMatch[1].trim();

  // Business Address
  const bizAddrMatch = text.match(/Business\s*Address\s*[:\-]?\s*(.+?)(?:\n|$)/im);
  if (bizAddrMatch) fields.business_address = bizAddrMatch[1].trim();

  // BIN Number
  const binMatch = text.match(/BIN\s*(?:NO|Number)?\s*[:\-]?\s*(\d+)/i);
  if (binMatch) fields.bin_no = binMatch[1];

  // Owner Name — "Owner's Name : Md. Santu Hadladar"
  const ownerMatch = text.match(/Owner['']?s?\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (ownerMatch) fields.owner_name = ownerMatch[1].trim();

  // Father/Husband Name
  const fatherMatch = text.match(/Father['']?s?(?:\/Husband['']?s?)?\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (fatherMatch) fields.father_name = fatherMatch[1].trim();

  // Mother Name
  const motherMatch = text.match(/Mother['']?s?\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im);
  if (motherMatch) fields.mother_name = motherMatch[1].trim();

  // NID/Passport — "NID/Passport/Birth Reg: No : 5982970484"
  const nidMatch = text.match(/NID[\w\/]*\s*(?:Reg)?[\s:]*No\s*[:\-]?\s*(\d+)/i);
  if (nidMatch) fields.nid_passport = nidMatch[1];

  // Zone/Market/Area
  const zoneMatch = text.match(/Zone\/Market\s*(?:Br\.?)?\s*[:\-]?\s*\n?\s*Area\s*[:\-]?\s*(\w+)/im);
  if (zoneMatch) fields.zone_market = zoneMatch[1].trim();

  // Present Address details
  const presentHolding = text.match(/Owner\s*Present\s*Address[\s\S]*?Holding\s*No\s*[:\-]?\s*([\w\-\/]+)/im);
  if (presentHolding) fields.present_holding = presentHolding[1].trim();

  const presentVillage = text.match(/Owner\s*Present[\s\S]*?Village\s*[:\-]?\s*(.+?)(?:\n|Postcode|$)/im);
  if (presentVillage) fields.present_village = presentVillage[1].trim();

  const presentPS = text.match(/Owner\s*Present[\s\S]*?P\.?S\.?\s*[:\-]?\s*(\w+)/im);
  if (presentPS) fields.present_ps = presentPS[1].trim();

  const presentDist = text.match(/Owner\s*Present[\s\S]*?District\s*[:\-]?\s*(\w+)/im);
  if (presentDist) fields.present_district = presentDist[1].trim();

  // Permanent Address details
  const permVillage = text.match(/(?:Owner\s*)?Permanent\s*Address[\s\S]*?(?:Village\s*[:\-]?\s*|Vill[\-\s]*)(\w+)/im);
  if (permVillage) fields.perm_village = permVillage[1].trim();

  const permPS = text.match(/Permanent[\s\S]*?P\.?S\.?\s*[:\-]?\s*(\w+)/im);
  if (permPS) fields.perm_ps = permPS[1].trim();

  const permDist = text.match(/Permanent[\s\S]*?District\s*[:\-]?\s*(\w+)/im);
  if (permDist) fields.perm_district = permDist[1].trim();

  // Fee items — "License/Renewal Fee : 3500", "VAT : 525", etc
  const feePattern = /([\w\/\s]+?(?:Fee|Tax|VAT|Surcharge))\s*[:\-]?\s*([\d,.]+)/gi;
  let feeMatch;
  let idx = 1;
  while ((feeMatch = feePattern.exec(text)) !== null) {
    const amount = feeMatch[2].replace(/,/g, "");
    if (parseFloat(amount) > 0) {
      fields[`Member${idx}_Item`] = feeMatch[1].trim();
      fields[`Member${idx}_Amount`] = amount;
      idx++;
    }
  }

  // Grand Total
  const totalMatch = text.match(/Grand\s*Total\s*[:\-]?\s*([\d,]+)/i);
  if (totalMatch) fields.grand_total = totalMatch[1].replace(/,/g, "");

  // Confidence
  const keyFields = ["license_no", "business_name", "owner_name"];
  const found = keyFields.filter(k => fields[k]).length;
  fields._confidence = found >= 2 ? "high" : found >= 1 ? "medium" : "low";

  return fields;
}

module.exports = router;
