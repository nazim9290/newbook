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
// POST /api/docgen/create-from-default — default template থেকে agency template তৈরি
router.post("/create-from-default", asyncHandler(async (req, res) => {
  const { default_template_id, template_name, category, description, linked_doc_type } = req.body;
  if (!default_template_id || !template_name) return res.status(400).json({ error: "default_template_id ও template_name দিন" });

  // Default template fetch
  const { data: dt } = await supabase.from("default_templates").select("*").eq("id", default_template_id).single();
  if (!dt || !dt.file_url) return res.status(404).json({ error: "Default template পাওয়া যায়নি বা ফাইল নেই" });

  // File copy — default → agency template
  const srcPath = path.join(__dirname, "../..", dt.file_url);
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Template file পাওয়া যায়নি: " + dt.file_url });

  const ext = path.extname(dt.file_name || "template.docx");
  const destName = `${req.user.agency_id}_${Date.now()}_${(dt.file_name || "template.docx").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destDir = path.join(__dirname, "../../uploads/doc-templates");
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, destName);
  fs.copyFileSync(srcPath, destPath);

  // Detect placeholders from copied file
  let placeholders = [];
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(destPath);
    const foundKeys = new Set();
    zip.getEntries().forEach(entry => {
      if (entry.entryName.endsWith(".xml")) {
        const cleaned = entry.getData().toString("utf8").replace(/<[^>]+>/g, "");
        (cleaned.match(/\{\{([^}]+)\}\}/g) || []).forEach(m => {
          const key = m.replace(/[{}]/g, "").trim();
          if (key && !foundKeys.has(key)) { foundKeys.add(key); placeholders.push({ key, placeholder: m, field: "" }); }
        });
      }
    });
  } catch (err) { console.error("[DocGen] Placeholder detect error:", err.message); }

  // Copy mappings from default template if available
  const dtData = typeof dt.template_data === "string" ? JSON.parse(dt.template_data || "{}") : (dt.template_data || {});
  if (dtData.placeholders) {
    placeholders = placeholders.map(p => {
      const saved = dtData.placeholders.find(sp => sp.key === p.key);
      return saved && saved.field ? { ...p, field: saved.field } : p;
    });
  }

  // Auto-map — placeholder name থেকে intelligent field match
  const AUTO_MAP = {
    "Register No": "register_no", "Date of Registration": "reg_date:jp",
    "Date of Issue": "issue_date:jp", "Birth Registration No": "birth_reg_no",
    "Name": "name_en", "Sex": "sex:jp", "Date of Birth": "dob:jp",
    "Place of Birth": "birth_place", "Father's Name": "father_name",
    "Father's Nationality": "father_nationality:jp", "Mother's Name": "mother_name",
    "Mother's Nationality": "mother_nationality:jp", "Permanent Address": "permanent_address",
    "BR Number": "birth_reg_no", "In Word": "dob_in_word",
  };
  placeholders = placeholders.map(p => {
    if (!p.field && AUTO_MAP[p.key]) return { ...p, field: AUTO_MAP[p.key] };
    return p;
  });

  // Save as agency template
  const { data: newTmpl, error } = await supabase.from("doc_templates").insert({
    agency_id: req.user.agency_id,
    name: template_name,
    category: category || "translation",
    description: description || dt.description || "",
    linked_doc_type: linked_doc_type || "",
    template_url: destPath,
    file_path: destPath,
    field_mappings: JSON.stringify(placeholders),
    placeholders: JSON.stringify(placeholders),
  }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  res.json({ template: newTmpl, placeholders });
}));

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

    // Related data — আলাদা queries (student relations + system context)
    const [eduRes, examRes, famRes, sponsorRes, workRes, jpStudyRes, agencyRes, schoolRes, batchRes, branchRes] = await Promise.all([
      supabase.from("student_education").select("*").eq("student_id", student_id),
      supabase.from("student_jp_exams").select("*").eq("student_id", student_id),
      supabase.from("student_family").select("*").eq("student_id", student_id),
      supabase.from("sponsors").select("*").eq("student_id", student_id),
      // Resume tables — 職歴, 日本語学習歴
      supabase.from("student_work_experience").select("*").eq("student_id", student_id),
      supabase.from("student_jp_study").select("*").eq("student_id", student_id),
      // সিস্টেম ভ্যারিয়েবল: এজেন্সি, স্কুল, ব্যাচ, ব্রাঞ্চ fetch
      // School: student-এর school_id → fallback school name search
      supabase.from("agencies").select("*").eq("id", req.user.agency_id).single(),
      student.school_id
        ? supabase.from("schools").select("*").eq("id", student.school_id).single()
        : student.school
          ? supabase.from("schools").select("*").eq("agency_id", req.user.agency_id).eq("name_en", student.school).limit(1)
          : { data: null },
      student.batch_id ? supabase.from("batches").select("*").eq("id", student.batch_id).single() : { data: null },
      student.branch ? supabase.from("branches").select("*").eq("agency_id", req.user.agency_id).eq("name", student.branch).single() : { data: null },
    ]);
    student.student_education = eduRes.data || [];
    student.student_jp_exams = examRes.data || [];
    student.student_family = famRes.data || [];
    student.sponsors = sponsorRes.data || [];
    // Resume tables — 職歴, 日本語学習歴
    student.work_experience = workRes.data || [];
    student.jp_study = jpStudyRes.data || [];

    // সিস্টেম context — agency, school, batch, branch
    const agency = agencyRes.data || {};
    const school = Array.isArray(schoolRes.data) ? schoolRes.data[0] || {} : schoolRes.data || {};
    const batch = batchRes.data || {};
    const branch = branchRes.data || {};

    // Decrypt sensitive fields
    const { decryptSensitiveFields } = require("../lib/crypto");
    const decrypted = decryptSensitiveFields(student);

    // Flatten student data + system context + document-specific data merge
    // doc_data (user input) priority, তারপর student profile + system context
    const flat = { ...flattenForDoc(decrypted, { agency, school, batch, branch }), ...doc_data };

    // Auto-generate issuing_authority — template_type অনুযায়ী
    if (!flat.issuing_authority) {
      if (flat.union_name) flat.issuing_authority = [flat.union_name, flat.upazila_name, flat.district_name].filter(Boolean).join(", ");
      else if (flat.paurashava_name) flat.issuing_authority = flat.paurashava_name;
      else if (flat.city_corp_name) flat.issuing_authority = [flat.city_corp_name, flat.zone ? `Zone-${flat.zone}` : ""].filter(Boolean).join(", ");
    }
    // Issuing location lines — template-এ আলাদা line হিসেবে ব্যবহার করা যাবে
    if (!flat.issuing_line1) {
      flat.issuing_line1 = flat.union_name || flat.paurashava_name || flat.city_corp_name || "";
      flat.issuing_line2 = flat.union_name ? [flat.upazila_name, flat.district_name].filter(Boolean).join(", ") : flat.zone ? `Zone-${flat.zone}` : "";
    }

    // Get template file buffer — VPS local
    let templateBuffer;
    const tmplPath = tmpl.template_url || tmpl.file_path;
    if (tmplPath && fs.existsSync(tmplPath)) {
      templateBuffer = fs.readFileSync(tmplPath);
    } else {
      return res.status(400).json({ error: "Template file পাওয়া যায়নি: " + tmplPath });
    }

    // ── Pre-process: :jp modifier-এ long text AI translate (async) ──
    // resolveValue sync — তাই আগেই translate করে flat-এ cache করি
    const jpTranslateCache = {};
    // Mapping data — field_mappings বা placeholders বা template_data থেকে পড়ি
    const parseJSON = (val) => { if (!val) return []; if (typeof val === "string") try { return JSON.parse(val); } catch { return []; } return Array.isArray(val) ? val : val?.placeholders || []; };
    const placeholderList = parseJSON(tmpl.field_mappings) || parseJSON(tmpl.placeholders) || parseJSON(tmpl.template_data?.placeholders) || [];
    for (const p of placeholderList) {
      const field = p.field || p.key || "";
      if (field.includes(":jp")) {
        const base = field.split(":")[0];
        const val = String(flat[base] || "");
        // Long text (50+ chars) → AI translate, short → resolveValue-এ JP_MAP handle করবে
        if (val.length >= 50) {
          console.log(`[DocGen] AI translating ${base} (${val.length} chars)...`);
          jpTranslateCache[base] = await translateToJapanese(val);
        }
      }
    }
    // Translated values flat-এ inject — :jp resolve করলে translated version পাবে
    Object.entries(jpTranslateCache).forEach(([k, v]) => { flat[k + "_jp"] = v; });

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

          // ── Step 1: XML tag দিয়ে ভাঙা placeholder জোড়া লাগানো ──
          // Word {{ ও }} এর মাঝে spellcheck/formatting tag ঢুকায়
          // {{<tags>reason_for_study<tags>}} → {{reason_for_study}}
          content = content.replace(/\{\{((?:<[^>]+>)*)([\w\s:_]+?)((?:<[^>]+>)*)\}\}/g, (match, pre, key, post) => {
            return `{{${key.replace(/<[^>]+>/g, "").trim()}}}`;
          });
          // আরো complex split: <w:t>{{</w:t>...<w:t>key</w:t>...<w:t>}}</w:t>
          // </w:t> ও <w:t> এর মাঝে placeholder key খুঁজে জোড়া লাগানো
          content = content.replace(/<w:t[^>]*>\{\{<\/w:t>(.*?)<w:t[^>]*>\}\}<\/w:t>/gs, (match, inner) => {
            const key = inner.replace(/<[^>]+>/g, "").trim();
            return `<w:t>{{${key}}}</w:t>`;
          });

          // ── Step 2: Mapping lookup — placeholder key → mapped field (with modifier) ──
          // placeholderList-এ mapping আছে: { key: "reason_for_study", field: "reason_for_study:jp" }
          const getMappedField = (rawKey) => {
            const p = placeholderList.find(pl => pl.key === rawKey);
            return p?.field || rawKey; // mapping থাকলে field ব্যবহার, না থাকলে raw key
          };

          let replaced = content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const k = key.trim();
            const mappedField = getMappedField(k);
            let val = resolveValue(flat, mappedField) || "";
            // Long text-এ \n\n (paragraph break) → Word XML paragraph break
            // \n (single line break) → Word XML line break
            if (val.includes("\n")) {
              val = val.replace(/\n\n/g, "</w:t></w:r></w:p><w:p><w:r><w:t>")
                       .replace(/\n/g, "</w:t><w:br/><w:t>");
            }
            return val;
          });

          // Handle split placeholders: {, {, k, e, y, }, } across <w:r> tags
          replaced = replaced.replace(/\{(?:<[^>]+>)*\{(?:<[^>]+>)*([^}<]+?)(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g, (match, key) => {
            const k = key.replace(/<[^>]+>/g, "").trim();
            const mappedField = getMappedField(k);
            return resolveValue(flat, mappedField) || "";
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

// Student data flatten — nested data কে flat key-value-তে convert
// context: { agency, school, batch, branch } — sys_* ভ্যারিয়েবলের জন্য
function flattenForDoc(student, context = {}) {
  const flat = { ...student };

  // ═══════════════════════════════════════════════════
  // Education — SSC, HSC, Honours/Bachelor
  // ═══════════════════════════════════════════════════
  const edu = student.student_education || student.education || [];
  const ssc = edu.find(e => (e.level || "").toLowerCase().includes("ssc")) || {};
  const hsc = edu.find(e => (e.level || "").toLowerCase().includes("hsc")) || {};
  const honours = edu.find(e => (e.level || "").toLowerCase().includes("bachelor") || (e.level || "").toLowerCase().includes("hon")) || {};

  flat.edu_ssc_school = ssc.school_name || "";
  flat.edu_ssc_year = ssc.passing_year || ssc.year || "";
  flat.edu_ssc_board = ssc.board || "";
  flat.edu_ssc_gpa = ssc.gpa || "";
  flat.edu_ssc_subject = ssc.group_name || ssc.subject_group || ssc.department || "";

  flat.edu_hsc_school = hsc.school_name || "";
  flat.edu_hsc_year = hsc.passing_year || hsc.year || "";
  flat.edu_hsc_board = hsc.board || "";
  flat.edu_hsc_gpa = hsc.gpa || "";
  flat.edu_hsc_subject = hsc.group_name || hsc.subject_group || hsc.department || "";

  flat.edu_honours_school = honours.school_name || "";
  flat.edu_honours_year = honours.passing_year || honours.year || "";
  flat.edu_honours_gpa = honours.gpa || "";
  flat.edu_honours_subject = honours.group_name || honours.subject_group || honours.department || "";

  // ═══════════════════════════════════════════════════
  // JP Exams
  // ═══════════════════════════════════════════════════
  const jp = (student.student_jp_exams || [])[0] || {};
  flat.jp_level = jp.level || ""; flat.jp_score = jp.score || "";
  flat.jp_exam_type = jp.exam_type || ""; flat.jp_result = jp.result || "";
  flat.jp_exam_date = jp.exam_date || "";

  // ═══════════════════════════════════════════════════
  // Sponsor — মূল তথ্য + 経費支弁書 extended fields
  // ═══════════════════════════════════════════════════
  const { decryptSensitiveFields } = require("../lib/crypto");
  const spRaw = (student.sponsors || [])[0] || {};
  const sp = decryptSensitiveFields(spRaw);
  flat.sponsor_name = sp.name || ""; flat.sponsor_name_en = sp.name_en || sp.name || "";
  flat.sponsor_phone = sp.phone || "";
  flat.sponsor_address = sp.address || ""; flat.sponsor_relationship = sp.relationship || "";
  // Extended sponsor fields — 経費支弁書 (Financial Sponsorship Document)
  flat.sponsor_statement = sp.statement || "";
  flat.sponsor_payment_to_student = sp.payment_to_student ? "✓" : "";
  flat.sponsor_payment_to_school = sp.payment_to_school ? "✓" : "";
  flat.sponsor_sign_date = sp.sign_date || "";
  flat.sponsor_tin = sp.tin || "";
  flat.sponsor_income = sp.annual_income_y1 || "";
  flat.sponsor_company = sp.company_name || "";
  flat.sponsor_nid = sp.nid || "";
  flat.tuition_jpy = sp.tuition_jpy || student.tuition_jpy || "";
  flat.monthly_living = sp.living_jpy_monthly || student.monthly_living || "";
  flat.exchange_rate = sp.exchange_rate || "";
  // Sponsor yearly income/tax — ৩ বছরের তথ্য
  flat.sponsor_income_y1 = sp.annual_income_y1 || "";
  flat.sponsor_income_y2 = sp.annual_income_y2 || "";
  flat.sponsor_income_y3 = sp.annual_income_y3 || "";
  flat.sponsor_tax_y1 = sp.tax_paid_y1 || sp.tax_y1 || "";
  flat.sponsor_tax_y2 = sp.tax_paid_y2 || sp.tax_y2 || "";
  flat.sponsor_tax_y3 = sp.tax_paid_y3 || sp.tax_y3 || "";

  // ═══════════════════════════════════════════════════
  // New Student fields — 入学願書 (Application for Admission)
  // birth_place, occupation, reason_for_study, future_plan, study_subject
  // ═══════════════════════════════════════════════════
  flat.birth_place = student.birth_place || "";
  flat.occupation = student.occupation || "Student";
  flat.reason_for_study = student.reason_for_study || "";
  flat.future_plan = student.future_plan || "";
  flat.study_subject = student.study_subject || "";

  // ═══════════════════════════════════════════════════
  // Detailed Education — elementary, junior_high, high_school (入学/卒業 + 所在地)
  // school_type / level で各段階を特定してflat key化
  // ═══════════════════════════════════════════════════
  const eduAll = student.student_education || student.education || [];
  const elementary = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("elem")) || {};
  const juniorHigh = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("junior")) || {};
  const highSchool = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("high") || (e.level || "").toLowerCase().includes("ssc")) || {};
  const technical = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("tech")) || {};
  const university = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("univ") || (e.level || "").toLowerCase().includes("bach")) || {};

  // Education helper — YYYY-MM format থেকে year, month আলাদা + duration calculate
  const eduFlat = (prefix, rec) => {
    const entrance = rec.entrance_year || "";
    const graduation = rec.passing_year || rec.year || "";
    flat[`${prefix}_school`] = rec.school_name || "";
    flat[`${prefix}_address`] = rec.address || "";
    flat[`${prefix}_entrance`] = entrance;
    flat[`${prefix}_graduation`] = graduation;
    // Sub-parts: "2009-01" → year=2009, month=1
    if (entrance.includes("-")) {
      const [ey, em] = entrance.split("-");
      flat[`${prefix}_entrance_year`] = ey || "";
      flat[`${prefix}_entrance_month`] = String(parseInt(em || "0")) || "";
    }
    if (graduation.includes("-")) {
      const [gy, gm] = graduation.split("-");
      flat[`${prefix}_graduation_year`] = gy || "";
      flat[`${prefix}_graduation_month`] = String(parseInt(gm || "0")) || "";
    }
    // Duration (年) — graduation year - entrance year
    const ey = parseInt((entrance || "").split("-")[0]);
    const gy = parseInt((graduation || "").split("-")[0]);
    flat[`${prefix}_duration`] = (ey && gy) ? String(gy - ey) : "";
  };

  eduFlat("edu_elementary", elementary);
  eduFlat("edu_junior", juniorHigh);
  eduFlat("edu_high", highSchool);
  eduFlat("edu_technical", technical);
  eduFlat("edu_university", university);

  // ═══════════════════════════════════════════════════
  // Work Experience — 職歴 (Vocational experience)
  // ═══════════════════════════════════════════════════
  const workAll = student.work_experience || [];
  workAll.forEach((w, i) => {
    flat[`work${i+1}_company`] = w.company_name || "";
    flat[`work${i+1}_address`] = w.address || "";
    flat[`work${i+1}_start`] = w.start_date || "";
    flat[`work${i+1}_end`] = w.end_date || "";
    flat[`work${i+1}_position`] = w.position || "";
  });
  // Shorthand — first entry without index (backward compat)
  const work = workAll[0] || {};
  flat.work_company = work.company_name || "";
  flat.work_address = work.address || "";
  flat.work_start = work.start_date || "";
  flat.work_end = work.end_date || "";
  flat.work_position = work.position || "";

  // ═══════════════════════════════════════════════════
  // JP Study History — 日本語学習歴 (Japanese educational history)
  // ═══════════════════════════════════════════════════
  const jpStudyAll = student.jp_study || [];
  jpStudyAll.forEach((js, i) => {
    flat[`jp_study${i+1}_institution`] = js.institution || "";
    flat[`jp_study${i+1}_address`] = js.address || "";
    flat[`jp_study${i+1}_from`] = js.period_from || "";
    flat[`jp_study${i+1}_to`] = js.period_to || "";
    flat[`jp_study${i+1}_hours`] = js.total_hours || "";
  });
  // Shorthand — first entry without index
  // JP Study data না থাকলে agency + batch data দিয়ে auto-populate
  const jpStudy = jpStudyAll[0] || {};
  const ctxAgency = (context || {}).agency || {};
  const ctxBatch = (context || {}).batch || {};
  flat.jp_study_institution = jpStudy.institution || ctxAgency.name || "";
  flat.jp_study_address = jpStudy.address || ctxAgency.address || "";
  flat.jp_study_from = jpStudy.period_from || ctxBatch.start_date || "";
  flat.jp_study_to = jpStudy.period_to || ctxBatch.end_date || "";
  flat.jp_study_hours = jpStudy.total_hours || ctxBatch.total_hours || "";
  // JP Study sub-parts — "2023-03-02" → year=2023, month=3, day=2
  if (flat.jp_study_from && flat.jp_study_from.includes("-")) {
    const [fy, fm, fd] = flat.jp_study_from.split("-");
    flat.jp_study_from_year = fy || ""; flat.jp_study_from_month = String(parseInt(fm || "0")) || ""; flat.jp_study_from_day = String(parseInt(fd || "0")) || "";
  }
  if (flat.jp_study_to && flat.jp_study_to.includes("-")) {
    const [ty, tm, td] = flat.jp_study_to.split("-");
    flat.jp_study_to_year = ty || ""; flat.jp_study_to_month = String(parseInt(tm || "0")) || ""; flat.jp_study_to_day = String(parseInt(td || "0")) || "";
  }

  // ═══════════════════════════════════════════════════
  // Family — বাবা, মা
  // ═══════════════════════════════════════════════════
  const fam = student.student_family || [];
  const father = fam.find(f => f.relation === "father") || {};
  const mother = fam.find(f => f.relation === "mother") || {};
  flat.father_dob = father.dob || ""; flat.father_occupation = father.occupation || "";
  flat.mother_dob = mother.dob || ""; flat.mother_occupation = mother.occupation || "";
  // Family addresses — প্রতিটি সদস্যের আলাদা ঠিকানা (入学願書 format)
  fam.forEach((m, i) => {
    flat[`family${i+1}_name`] = m.name || m.name_en || "";
    flat[`family${i+1}_relation`] = m.relation || "";
    flat[`family${i+1}_dob`] = m.dob || "";
    flat[`family${i+1}_occupation`] = m.occupation || "";
    flat[`family${i+1}_address`] = m.address || "";
  });

  // ═══════════════════════════════════════════════════
  // Extended Sponsor — 入学願書 additional fields
  // ═══════════════════════════════════════════════════
  flat.sponsor_dob = sp.dob || "";
  flat.sponsor_company_phone = sp.company_phone || "";
  flat.sponsor_company_address = sp.company_address || "";

  // ═══════════════════════════════════════════════════
  // Age — DOB থেকে বয়স
  // ═══════════════════════════════════════════════════
  if (flat.dob) {
    flat.age = String(Math.floor((Date.now() - new Date(flat.dob)) / (365.25 * 24 * 60 * 60 * 1000)));
  }

  // ═══════════════════════════════════════════════════
  // Today's date — বিভিন্ন format
  // ═══════════════════════════════════════════════════
  const today = new Date();
  flat.today = today.toISOString().slice(0, 10);
  flat.today_jp = today.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

  // ═══════════════════════════════════════════════════
  // System Variables — agency, branch, school, batch
  // context থেকে DB data ব্যবহার করে sys_* prefix-এ set
  // ═══════════════════════════════════════════════════
  const { agency = {}, school = {}, batch = {}, branch = {} } = context;

  // এজেন্সি
  flat.sys_agency_name = agency.name || "";
  flat.sys_agency_name_bn = agency.name_bn || "";
  flat.sys_agency_address = agency.address || "";
  flat.sys_agency_phone = agency.phone || "";
  flat.sys_agency_email = agency.email || "";

  // ব্রাঞ্চ — fallback: student.branch (name string)
  flat.sys_branch_name = branch.name || student.branch || "";
  flat.sys_branch_address = branch.address || branch.address_bn || "";
  flat.sys_branch_phone = branch.phone || "";
  flat.sys_branch_manager = branch.manager || "";

  // স্কুল — fallback: student.school (name string)
  flat.sys_school_name = school.name_en || student.school || "";
  flat.sys_school_name_jp = school.name_jp || "";
  flat.sys_school_address = school.address || "";

  // ব্যাচ — fallback: student.batch (name string)
  flat.sys_batch_name = batch.name || student.batch || "";
  flat.sys_batch_start = batch.start_date || "";
  flat.sys_batch_end = batch.end_date || "";
  flat.sys_batch_teacher = batch.teacher || "";
  flat.sys_batch_schedule = batch.schedule || "";

  // ব্যাচ শিডিউল — ক্লাসের দিন, সময়, ঘণ্টা (auto-calculated)
  flat.sys_batch_class_days = (batch.class_days || []).join(", ");
  flat.sys_batch_class_time = batch.class_time || "";
  flat.sys_batch_hours_per_day = batch.class_hours_per_day || "";
  flat.sys_batch_weekly_hours = batch.weekly_hours || "";
  flat.sys_batch_total_classes = batch.total_classes || "";
  flat.sys_batch_total_hours = batch.total_hours || "";

  // sys_today — today alias with sys_ prefix
  flat.sys_today = flat.today;
  flat.sys_today_jp = flat.today_jp;

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

    // Built-in Japanese translations — short values
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
      // Short value → JP_MAP lookup
      if (JP_MAP[val]) return JP_MAP[val];
      // Long text → pre-translated cache check (base_jp key-তে রাখা হয়)
      if (flat[base + "_jp"]) return flat[base + "_jp"];
      // Date check — YYYY-MM-DD format হলে Japanese date-এ convert
      if (val.match(/^\d{4}-\d{2}-\d{2}/)) {
        const [y, m, d] = val.split("-");
        return `${y}年${parseInt(m)}月${parseInt((d || "").slice(0, 2))}日`;
      }
      return val;
    }

    return val;
  }
  return flat[key] ?? "";
}

// ═══════════════════════════════════════════════════════
// AI Japanese Translation — long text (Purpose of Study etc.)
// Claude Haiku দিয়ে English → Japanese translate
// Result cache হয় — পরবর্তীতে API call লাগে না
// ═══════════════════════════════════════════════════════
async function translateToJapanese(text) {
  if (!text || text.length < 20) return text;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return text;

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
          content: `Translate the following English text to natural Japanese. This is a "Purpose of Study" letter for a Japanese student visa application. Use formal Japanese (です/ます form). Keep paragraph structure. Return ONLY the Japanese translation, nothing else.\n\n${text}`
        }],
      }),
    });
    if (!response.ok) return text;
    const result = await response.json();
    return result.content?.[0]?.text || text;
  } catch {
    return text;
  }
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
