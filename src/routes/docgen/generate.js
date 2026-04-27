/**
 * generate.js — Document generation route
 *
 * POST /generate — template + student → .docx/.pdf download
 *   Flow: student data fetch → flatten → AI translate (long :jp text) →
 *         .docx XML placeholder replace → (optional) LibreOffice → PDF
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { decryptSensitiveFields } = require("../../lib/crypto");
const { flattenForDoc, mergeDocData } = require("../../lib/docgen/studentFlatten");
const { resolveValue } = require("../../lib/docgen/valueResolver");
const { translateToJapanese } = require("../../lib/docgen/aiHelpers");

const router = express.Router();
router.use(auth);

// POST /api/docgen/generate — template + student → .docx download
// Body: { template_id, student_id, format: "docx" | "pdf" }
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

    // Related data — আলাদা queries (student relations + system context + doc_type field values)
    const [eduRes, examRes, famRes, sponsorRes, workRes, jpStudyRes, agencyRes, schoolRes, batchRes, branchRes, docDataRes] = await Promise.all([
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
      // Doc Type-defined field values (TIN/Birth Cert/Passport ইত্যাদি — Documents module-এ user fill করেছে)
      supabase.from("document_data").select("doc_type_id, field_data, doc_types(name)").eq("student_id", student_id).eq("agency_id", req.user.agency_id),
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
    const decrypted = decryptSensitiveFields(student);

    // Flatten student data + system context. তারপর namespaced doc-type fields merge করি,
    // সবশেষে generate-time doc_data (user input) priority পায়।
    const flat = { ...flattenForDoc(decrypted, { agency, school, batch, branch }) };
    mergeDocData(flat, docDataRes.data || []);
    Object.assign(flat, doc_data || {});

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
        if (val.length >= 50) {
          // ── Cache check — student record-এ আগে translate হয়ে থাকলে সেটা ব্যবহার ──
          const cacheKey = `${base}_jp`;
          const cachedJp = decrypted[cacheKey] || student[cacheKey] || "";
          // Cache valid = source text না বদলালে (hash match)
          const sourceHash = require("crypto").createHash("md5").update(val).digest("hex").slice(0, 8);
          const cachedHash = decrypted[`${cacheKey}_hash`] || student[`${cacheKey}_hash`] || "";

          if (cachedJp && cachedHash === sourceHash) {
            console.log(`[DocGen] JP cache hit: ${base} (${cachedJp.length} chars)`);
            jpTranslateCache[base] = cachedJp;
          } else {
            console.log(`[DocGen] AI translating ${base} (${val.length} chars)...`);
            const translated = await translateToJapanese(val);
            jpTranslateCache[base] = translated;
            // ── Student record-এ cache save — পরেরবার AI call লাগবে না ──
            try {
              await supabase.from("students").update({
                [cacheKey]: translated,
                [`${cacheKey}_hash`]: sourceHash,
              }).eq("id", student_id);
            } catch (e) { console.error("[JP Cache Save]", e.message); }
          }
        }
      }
    }
    Object.entries(jpTranslateCache).forEach(([k, v]) => { flat[k + "_jp"] = v; });

    // Replace {{placeholders}} in .docx
    // .docx is a zip of XML files — simple text replace in the XML
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
        const tmpDir = path.join(__dirname, "../../../uploads/ocr-temp");
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

module.exports = router;
