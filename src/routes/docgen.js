/**
 * docgen.js — Document Generator (Translation Template)
 *
 * .docx template upload → {{placeholder}} detect → student data fill → .docx/.pdf download
 * ব্যবহার: Birth Certificate Translation, NID Translation, ইত্যাদি
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// Filename sanitization — path traversal ও special char সরাও
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

// Allowed MIME types for docx upload
const ALLOWED_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/octet-stream",
];

// File upload — sanitized filename + MIME validation
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../uploads"),
  filename: (req, file, cb) => cb(null, `doctemplate_${Date.now()}_${sanitize(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // MIME type validation — শুধু .docx / .doc allow
    if (ALLOWED_MIMES.includes(file.mimetype) || file.originalname.match(/\.(docx?|DOCX?)$/)) {
      cb(null, true);
    } else {
      cb(new Error("শুধু .docx বা .doc ফাইল আপলোড করুন"));
    }
  },
});

// ================================================================
// GET /api/docgen/templates — সব document template
// ================================================================
router.get("/templates", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("doc_templates")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("created_at", { ascending: false });

  if (error) {
    // Table না থাকলে empty return
    if (error.message && error.message.includes("does not exist")) return res.json([]);
    return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
  res.json(data || []);
}));

// ================================================================
// POST /api/docgen/upload — .docx template upload + {{}} detect
// ================================================================
router.post("/upload", upload.single("file"), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
    const { template_name, category } = req.body;
    if (!template_name) return res.status(400).json({ error: "Template নাম দিন" });

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

    // Local VPS-এ permanent path-এ save
    const permanentDir = path.join(__dirname, "../../uploads/doc-templates");
    if (!fs.existsSync(permanentDir)) fs.mkdirSync(permanentDir, { recursive: true });
    const safeName = `${agencyId}_${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._\-]/g, "_")}`;
    const permanentPath = path.join(permanentDir, safeName);
    fs.copyFileSync(req.file.path, permanentPath);
    try { fs.unlinkSync(req.file.path); } catch {}

    const fileBuffer = fs.readFileSync(permanentPath);

    // Parse .docx (ZIP of XML files) to find {{placeholders}}
    const AdmZip = require("adm-zip");
    const placeholders = [];
    const seen = new Set();

    try {
      const zip = new AdmZip(fileBuffer);
      const entries = zip.getEntries();

      entries.forEach(entry => {
        // .docx-এর content XML files: word/document.xml, header, footer
        if (entry.entryName.endsWith(".xml")) {
          const xmlContent = entry.getData().toString("utf8");
          // XML tags সরিয়ে plain text বানাও — তারপর {{key}} search
          // এতে split placeholder ({{ across multiple <w:r> tags) ও ধরা পড়বে
          const plainText = xmlContent.replace(/<[^>]+>/g, "");
          const matches = plainText.match(/\{\{([^}]+)\}\}/g) || [];
          matches.forEach(m => {
            const key = m.replace(/\{\{|\}\}/g, "").trim();
            // XML tag বা invalid char থাকলে skip
            if (key.includes("<") || key.includes(">") || key.includes("/") || key.length > 50) return;
            if (!seen.has(key)) { seen.add(key); placeholders.push({ placeholder: `{{${key}}}`, key, field: key }); }
          });
        }
      });
    } catch (parseErr) {
      console.error("docx parse error:", parseErr.message);
      // Fallback: raw binary search
      const rawContent = fileBuffer.toString("binary");
      const rawMatches = rawContent.match(/\{\{([^}]+)\}\}/g) || [];
      rawMatches.forEach(m => {
        const key = m.replace(/\{\{|\}\}/g, "").trim();
        if (!seen.has(key)) { seen.add(key); placeholders.push({ placeholder: `{{${key}}}`, key, field: key }); }
      });
    }

    // Save to DB — column names match actual table schema
    const { data: tmpl, error: dbErr } = await supabase
      .from("doc_templates")
      .insert({
        agency_id: agencyId,
        name: template_name,
        category: category || "translation",
        description: req.body.description || req.file.originalname,
        template_url: permanentPath,
        file_path: permanentPath,
        field_mappings: JSON.stringify(placeholders),
        placeholders: JSON.stringify(placeholders),
      })
      .select()
      .single();

    if (dbErr) { console.error("[DB]", dbErr.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

    res.json({ template: tmpl, placeholders });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/docgen/generate — template + student → .docx download
// Body: { template_id, student_id, format: "docx" | "pdf" }
// ================================================================
router.post("/generate", asyncHandler(async (req, res) => {
  try {
    const { template_id, student_id, format = "docx", doc_data = {} } = req.body;
    if (!template_id || !student_id) return res.status(400).json({ error: "template_id ও student_id দিন" });

    // Get template
    const { data: tmpl } = await supabase.from("doc_templates").select("*").eq("id", template_id).eq("agency_id", req.user.agency_id).single();
    if (!tmpl) return res.status(404).json({ error: "Template পাওয়া যায়নি" });

    // Get student — আলাদা query (join issue avoid)
    const { data: student } = await supabase
      .from("students")
      .select("*")
      .eq("id", student_id)
      .single();
    if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

    // Related data — আলাদা queries
    const [eduRes, examRes, famRes, sponsorRes] = await Promise.all([
      supabase.from("student_education").select("*").eq("student_id", student_id),
      supabase.from("student_jp_exams").select("*").eq("student_id", student_id),
      supabase.from("student_family").select("*").eq("student_id", student_id),
      supabase.from("sponsors").select("*").eq("student_id", student_id),
    ]);
    student.student_education = eduRes.data || [];
    student.student_jp_exams = examRes.data || [];
    student.student_family = famRes.data || [];
    student.sponsors = sponsorRes.data || [];

    // Decrypt sensitive fields
    const { decryptSensitiveFields } = require("../lib/crypto");
    const decrypted = decryptSensitiveFields(student);

    // Flatten student data + document-specific data merge
    // doc_data (user input) priority, তারপর student profile
    const flat = { ...flattenForDoc(decrypted), ...doc_data };

    // Get template file buffer — VPS local
    let templateBuffer;
    const tmplPath = tmpl.template_url || tmpl.file_path;
    if (tmplPath && fs.existsSync(tmplPath)) {
      templateBuffer = fs.readFileSync(tmplPath);
    } else {
      return res.status(400).json({ error: "Template file পাওয়া যায়নি: " + tmplPath });
    }

    // Replace {{placeholders}} in .docx
    // .docx is a zip of XML files — simple text replace in the XML
    const JSZip = require("jszip") || null;
    let outputBuffer;

    try {
      // Try using jszip to process docx
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(templateBuffer);
      const entries = zip.getEntries();

      entries.forEach(entry => {
        if (entry.entryName.endsWith(".xml") || entry.entryName.endsWith(".rels")) {
          let content = entry.getData().toString("utf8");
          // Replace {{key}} — but in docx XML, {{key}} might be split across XML tags
          // First try simple replace
          let replaced = content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const k = key.trim();
            return resolveValue(flat, k) || "";
          });

          // Handle split placeholders: {, {, k, e, y, }, } across <w:r> tags
          // Remove XML tags between {{ and }}
          replaced = replaced.replace(/\{(?:<[^>]+>)*\{(?:<[^>]+>)*([^}<]+?)(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g, (match, key) => {
            const k = key.replace(/<[^>]+>/g, "").trim();
            return resolveValue(flat, k) || "";
          });

          zip.updateFile(entry.entryName, Buffer.from(replaced, "utf8"));
        }
      });

      outputBuffer = zip.toBuffer();
    } catch {
      // Fallback: simple binary replace
      let content = templateBuffer.toString("binary");
      content = content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        return resolveValue(flat, key.trim()) || "";
      });
      outputBuffer = Buffer.from(content, "binary");
    }

    // Send as .docx
    const studentName = (decrypted.name_en || student_id).replace(/[^a-zA-Z0-9_\- ]/g, "");
    const templateName = (tmpl.name || "document").replace(/[^a-zA-Z0-9_\- ]/g, "");

    if (format === "pdf") {
      // PDF: replaced .docx → LibreOffice headless → PDF
      try {
        const { execSync } = require("child_process");
        const tmpDir = path.join(__dirname, "../../uploads/ocr-temp");
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        // Temp .docx file save
        const tmpDocx = path.join(tmpDir, `gen_${Date.now()}.docx`);
        fs.writeFileSync(tmpDocx, outputBuffer);

        // LibreOffice convert → PDF
        execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${tmpDocx}"`, { timeout: 30000 });
        const tmpPdf = tmpDocx.replace(".docx", ".pdf");

        if (fs.existsSync(tmpPdf)) {
          const pdfBuffer = fs.readFileSync(tmpPdf);
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${templateName}_${studentName}.pdf"`);
          res.send(pdfBuffer);
          // Cleanup
          try { fs.unlinkSync(tmpDocx); fs.unlinkSync(tmpPdf); } catch {}
          return;
        }
        throw new Error("PDF conversion failed");
      } catch (pdfErr) {
        console.error("[DocGen] PDF error:", pdfErr.message);
        // Fallback: send .docx instead
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("Content-Disposition", `attachment; filename="${templateName}_${studentName}.docx"`);
        res.send(outputBuffer);
        return;
      }
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${templateName}_${studentName}.docx"`);
    res.send(outputBuffer);
  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

// ================================================================
// POST /api/docgen/templates/:id/mapping — placeholder → field mapping save
// ================================================================
router.post("/templates/:id/mapping", asyncHandler(async (req, res) => {
  let { placeholders } = req.body;
  if (!placeholders) return res.status(400).json({ error: "placeholders দিন" });
  if (typeof placeholders === "string") try { placeholders = JSON.parse(placeholders); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  if (!Array.isArray(placeholders)) placeholders = [];

  const { data, error } = await supabase
    .from("doc_templates")
    .update({ field_mappings: JSON.stringify(placeholders), placeholders: JSON.stringify(placeholders) })
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select()
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// ================================================================
// DELETE /api/docgen/templates/:id
// ================================================================
router.delete("/templates/:id", asyncHandler(async (req, res) => {
  const { data: tmpl } = await supabase.from("doc_templates").select("template_url").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (tmpl?.template_url && fs.existsSync(tmpl.template_url)) {
    try { fs.unlinkSync(tmpl.template_url); } catch {}
  }
  const { error } = await supabase.from("doc_templates").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json({ success: true });
}));

// ================================================================
// HELPERS
// ================================================================

// Student data flatten (same logic as excel)
function flattenForDoc(student) {
  const flat = { ...student };

  // Education
  const edu = student.student_education || [];
  const ssc = edu.find(e => (e.level || "").toLowerCase().includes("ssc")) || {};
  const hsc = edu.find(e => (e.level || "").toLowerCase().includes("hsc")) || {};
  flat.edu_ssc_school = ssc.school_name || ""; flat.edu_ssc_year = ssc.year || "";
  flat.edu_hsc_school = hsc.school_name || ""; flat.edu_hsc_year = hsc.year || "";

  // JP Exams
  const jp = (student.student_jp_exams || [])[0] || {};
  flat.jp_level = jp.level || ""; flat.jp_score = jp.score || "";

  // Sponsor
  const sp = (student.sponsors || [])[0] || {};
  flat.sponsor_name = sp.name || ""; flat.sponsor_phone = sp.phone || "";
  flat.sponsor_address = sp.address || ""; flat.sponsor_relationship = sp.relationship || "";

  // Family
  const fam = student.student_family || [];
  const father = fam.find(f => f.relation === "father") || {};
  const mother = fam.find(f => f.relation === "mother") || {};
  flat.father_dob = father.dob || ""; flat.father_occupation = father.occupation || "";
  flat.mother_dob = mother.dob || ""; flat.mother_occupation = mother.occupation || "";

  // Age
  if (flat.dob) {
    flat.age = String(Math.floor((Date.now() - new Date(flat.dob)) / (365.25 * 24 * 60 * 60 * 1000)));
  }

  // Today's date
  flat.today = new Date().toISOString().slice(0, 10);
  flat.today_jp = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

  return flat;
}

// Resolve value with sub-field support (:year, :month, :day, :first, :last)
/**
 * resolveValue — placeholder থেকে value বের করে
 *
 * Supported formats:
 *   {{name_en}}              → simple field
 *   {{dob:year}}             → date part: year/month/day
 *   {{name_en:first}}        → first word
 *   {{name_en:last}}         → remaining words
 *   {{dob:jp}}               → 2000年11月13日
 *   {{dob:slash}}            → 2000/11/13
 *   {{dob:dot}}              → 13.11.2000
 *   {{gender:jp}}            → Male→男, Female→女
 *   {{nationality:jp}}       → Bangladeshi→バングラデシュ
 *   {{marital_status:jp}}    → Single→未婚, Married→既婚
 *   {{field:map(A=X,B=Y)}}   → custom mapping: if field=A → X, if B → Y
 */
function resolveValue(flat, key) {
  if (!key) return "";

  // Custom mapping: {{field:map(Male=男,Female=女)}}
  const mapMatch = key.match(/^(.+?):map\((.+)\)$/);
  if (mapMatch) {
    const val = String(flat[mapMatch[1]] || "");
    const mappings = {};
    mapMatch[2].split(",").forEach(pair => {
      const [from, to] = pair.split("=");
      if (from && to) mappings[from.trim()] = to.trim();
    });
    return mappings[val] || val;
  }

  if (key.includes(":")) {
    const [base, mod] = key.split(":");
    const val = String(flat[base] || "");
    if (!val) return "";

    // Date modifiers
    if (val.includes("-") && val.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y, m, d] = val.split("-");
      const dd = (d || "").slice(0, 2);
      if (mod === "year") return y;
      if (mod === "month") return m;
      if (mod === "day") return dd;
      if (mod === "jp") return `${y}年${parseInt(m)}月${parseInt(dd)}日`;
      if (mod === "slash") return `${y}/${m}/${dd}`;
      if (mod === "dot") return `${dd}.${m}.${y}`;
      if (mod === "dmy") return `${dd}/${m}/${y}`;
      if (mod === "mdy") return `${m}/${dd}/${y}`;
    }

    // Name modifiers
    if (mod === "first") { const parts = val.trim().split(/\s+/); return parts[0] || ""; }
    if (mod === "last") { const parts = val.trim().split(/\s+/); return parts.slice(1).join(" ") || ""; }

    // Built-in Japanese translations
    if (mod === "jp") {
      const JP_MAP = {
        "Male": "男", "Female": "女", "Other": "その他",
        "Bangladeshi": "バングラデシュ", "Bangladesh": "バングラデシュ",
        "Single": "未婚", "Married": "既婚", "Divorced": "離婚", "Widowed": "寡婦",
        "A+": "A型(Rh+)", "A-": "A型(Rh-)", "B+": "B型(Rh+)", "B-": "B型(Rh-)",
        "AB+": "AB型(Rh+)", "AB-": "AB型(Rh-)", "O+": "O型(Rh+)", "O-": "O型(Rh-)",
        "Individual": "個人", "Company": "法人",
        "Science": "理系", "Commerce": "商業", "Arts": "文系",
      };
      return JP_MAP[val] || val;
    }

    return val;
  }
  return flat[key] ?? "";
}

// Simple HTML for PDF fallback
function generateHTMLFromFlat(flat, placeholders) {
  const rows = placeholders.map(p => {
    const val = resolveValue(flat, p.field || p.key);
    return `<tr><td style="padding:5px;border:1px solid #ddd;font-weight:bold">${p.key}</td><td style="padding:5px;border:1px solid #ddd">${val}</td></tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:30px}table{width:100%;border-collapse:collapse}h1{font-size:18px}</style></head><body><h1>${flat.name_en || "Student"} — Document</h1><table>${rows}</table><p style="margin-top:30px;font-size:12px">Generated: ${flat.today}</p></body></html>`;
}

module.exports = router;
