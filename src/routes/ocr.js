/**
 * ocr.js — Birth Certificate OCR Route (জন্ম নিবন্ধন স্ক্যান)
 *
 * Google Cloud Vision API ব্যবহার করে birth certificate image থেকে
 * English text extract করে structured fields-এ parse করে।
 *
 * Environment Variable প্রয়োজন:
 *   GOOGLE_VISION_API_KEY — Google Cloud Console থেকে API key নিতে হবে
 *   (Vision API enable থাকতে হবে project-এ)
 *
 * Endpoint:
 *   POST /api/ocr/scan — multipart/form-data, field name: "file"
 *   Optional query: ?doc_type=birth_certificate (ভবিষ্যতে অন্য doc type support করা যাবে)
 *
 * Supported formats: JPEG, PNG, WebP, PDF (max 10MB)
 * Supported templates: Paurashava, City Corporation, Union Parishad
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
 * Birth certificate image upload → Google Vision OCR → structured fields extract
 *
 * Request: multipart/form-data, field "file" (JPEG/PNG/WebP/PDF)
 * Response: { success, raw_text, extracted_fields, confidence }
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

    // ── Birth certificate fields parse করো ──
    const fields = parseBirthCertificate(fullText);

    res.json({
      success: true,
      raw_text: fullText,
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
