/**
 * scan.js — Main OCR scanning route
 *
 * POST /scan — file upload → Google Vision OCR → Haiku AI extract → fallback regex
 *   Flow: Credit check → PDF→Image (if PDF) → Vision OCR → Haiku → Regex fallback → Credit deduct
 *   Cost: 5 credit/scan (৳1 = 1 credit)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const auth = require("../../middleware/auth");
const { upload } = require("./_shared");
const { detectAndParse } = require("../../lib/ocr/parsers");
const { DOC_CONFIGS } = require("../../lib/ocr/docConfigs");
const { getOcrCredits, deductCredit, CREDITS_PER_SCAN } = require("../../lib/ocr/creditHelpers");
const { extractWithHaiku } = require("../../lib/ocr/haikuExtract");

const router = express.Router();
router.use(auth);

router.post("/scan", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded — supported: JPEG, PNG, WebP, PDF (max 10MB)" });

  const filePath = req.file.path;

  try {
    // ── Step 0: Credit check — প্রতি scan-এ 5 credit লাগে ──
    const credits = await getOcrCredits(req.user.agency_id);
    if (credits < CREDITS_PER_SCAN) {
      return res.status(402).json({
        error: `OCR credit অপর্যাপ্ত (${credits}/${CREDITS_PER_SCAN}) — অ্যাডমিনের সাথে যোগাযোগ করুন`,
        code: "NO_CREDITS",
        credits,
        required: CREDITS_PER_SCAN,
      });
    }

    // ── PDF → Image conversion — PDF হলে pdftoppm দিয়ে প্রথম পেজ image-এ convert ──
    const isPdf = req.file.mimetype === "application/pdf" || req.file.originalname.toLowerCase().endsWith(".pdf");
    let ocrFilePath = filePath;

    if (isPdf) {
      const { execSync } = require("child_process");
      const pdfImageBase = filePath.replace(/\.pdf$/i, "_page");
      try {
        // PDF → JPEG (প্রথম 3 পেজ, 300 DPI — OCR-এর জন্য ভালো quality)
        execSync(`pdftoppm -jpeg -r 300 -l 3 "${filePath}" "${pdfImageBase}"`, { timeout: 30000 });
        // pdftoppm output: _page-1.jpg, _page-2.jpg, etc.
        const pages = fs.readdirSync(path.dirname(pdfImageBase))
          .filter(f => f.startsWith(path.basename(pdfImageBase)) && f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(path.dirname(pdfImageBase), f));
        if (pages.length > 0) {
          ocrFilePath = pages[0]; // প্রথম পেজ — পরে সব পেজ merge করা যাবে
          console.log(`[OCR] PDF converted: ${pages.length} pages, using first page for OCR`);
        } else {
          console.error("[OCR] PDF conversion produced no images");
        }
      } catch (pdfErr) {
        console.error("[OCR] PDF to image conversion failed:", pdfErr.message);
      }
    }

    const imageBuffer = fs.readFileSync(ocrFilePath);
    const base64Image = imageBuffer.toString("base64");

    const base64SizeMB = (base64Image.length * 3 / 4) / (1024 * 1024);
    console.log(`[OCR] File: ${req.file.originalname}, isPdf: ${isPdf}, Size: ${base64SizeMB.toFixed(2)}MB, Credits: ${credits}`);
    if (base64SizeMB > 8) return res.status(400).json({ error: "Image too large — max 8MB" });

    // ── Step 1: Google Vision OCR — raw text extract ──
    // PDF multi-page: সব পেজ OCR করে merge
    const visionApiKey = process.env.GOOGLE_VISION_API_KEY;
    let fullText = "";

    if (visionApiKey) {
      // PDF হলে সব converted page OCR করো
      const pagesToOcr = isPdf ? (() => {
        const pdfImageBase = filePath.replace(/\.pdf$/i, "_page");
        return fs.readdirSync(path.dirname(pdfImageBase))
          .filter(f => f.startsWith(path.basename(pdfImageBase)) && f.endsWith(".jpg"))
          .sort()
          .map(f => path.join(path.dirname(pdfImageBase), f));
      })() : [ocrFilePath];

      for (const pageFile of pagesToOcr) {
        const pageBuffer = fs.readFileSync(pageFile);
        const pageBase64 = pageBuffer.toString("base64");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requests: [{ image: { content: pageBase64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] }),
              signal: controller.signal,
            }
          );
          clearTimeout(timeout);
          const data = await response.json();
          const pageText = data.responses?.[0]?.fullTextAnnotation?.text || "";
          if (pageText) fullText += (fullText ? "\n\n--- PAGE BREAK ---\n\n" : "") + pageText;
        } catch (fetchErr) {
          clearTimeout(timeout);
          console.error("[OCR] Vision API error on page:", fetchErr.message);
        }
      }

      // Cleanup temp PDF images
      if (isPdf) {
        const pdfImageBase = filePath.replace(/\.pdf$/i, "_page");
        try {
          fs.readdirSync(path.dirname(pdfImageBase))
            .filter(f => f.startsWith(path.basename(pdfImageBase)) && f.endsWith(".jpg"))
            .forEach(f => fs.unlinkSync(path.join(path.dirname(pdfImageBase), f)));
        } catch {}
      }
    }

    if (!fullText.trim()) {
      return res.status(400).json({ error: "No text detected — upload a clearer image" });
    }

    // ── Step 2: Claude Haiku AI extraction (primary) ──
    let result = null;
    let engine = "regex";

    // Frontend থেকে আসা expected fields ও doc type name
    let expectedFields = [];
    const docTypeName = req.body?.doc_type_name || "";
    try { expectedFields = JSON.parse(req.body?.expected_fields || "[]"); } catch {}

    if (process.env.ANTHROPIC_API_KEY) {
      result = await extractWithHaiku(fullText, DOC_CONFIGS, expectedFields, docTypeName);
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
