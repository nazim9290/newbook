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

  // ── 6. Birth Certificate ──
  {
    id: "birth_certificate",
    detect: /birth\s*(registration|certificate)/i,
    fields: [
      { key: "birth_reg_no", patterns: [/\b(\d{17})\b/] },
      { key: "register_no", patterns: [/Register\s*No[:\s]*(\d[\s\d]*\d)/i], type: "number" },
      { key: "name_en", patterns: [/(?:^|\n)\s*Name\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/im] },
      { key: "dob", patterns: [/Date\s*of\s*Birth\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "dob_in_word", patterns: [/(?:In\s*Word|in\s*words?)\s*[:\-]?\s*([A-Za-z\s,]+?(?:Thousand|Hundred)[A-Za-z\s]*)/i] },
      { key: "sex", patterns: [/Sex\s*[:\-]?\s*(Male|Female|Other)/i] },
      { key: "birth_place", patterns: [/Place\s*of\s*Birth\s*[:\-]?\s*([A-Za-z\s,.-]+?)(?:\n|$)/i] },
      { key: "father_name", patterns: [/Father\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/i] },
      { key: "father_nationality", patterns: [/Father['']?s?\s*Nationality\s*[:\-]?\s*([A-Za-z]+)/i] },
      { key: "mother_name", patterns: [/Mother\s*[:\-]?\s*([A-Za-z\s.]+?)(?:\n|$)/i] },
      { key: "mother_nationality", patterns: [/Mother['']?s?\s*Nationality\s*[:\-]?\s*([A-Za-z]+)/i] },
      { key: "permanent_address", patterns: [/Permanent\s*Address\s*[:\-]?\s*([A-Za-z\d\s,.\-\/]+?)(?:\n|Date|$)/i] },
      { key: "reg_date", patterns: [/Date\s*of\s*Registration\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "issue_date", patterns: [/Date\s*of\s*Issu(?:e|ance)\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i], type: "date" },
      { key: "paurashava_name", patterns: [/(\w+)\s*Paurashava/i] },
      { key: "zone", patterns: [/Zone[:\-\s]*(\d+)/i] },
      { key: "city_corp_name", patterns: [/([\w\s]+)\s*(?:City\s*Corporation)/i] },
      { key: "union_name", patterns: [/([\w\s]+)\s*Union\s*Parishad/i] },
      { key: "upazila_name", patterns: [/(?:Upazila|Upozila)[:\-\s]*([\w\s]+?)(?:,|\n|$)/i] },
      { key: "district_name", patterns: [/Dist(?:rict)?[:\-.\s]*([\w\s]+?)(?:,|\n|$)/i] },
    ],
    postProcess: (fields, text) => {
      // Template type auto-detect
      if (/paurashava/i.test(text)) fields.template_type = "Paurashava";
      else if (/city corporation/i.test(text)) fields.template_type = "City Corporation";
      else if (/union parishad/i.test(text)) fields.template_type = "Union Parishad";
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
