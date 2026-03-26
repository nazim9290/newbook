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

const router = express.Router();
router.use(auth);

// File upload
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../uploads"),
  filename: (req, file, cb) => cb(null, `doctemplate_${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ================================================================
// GET /api/docgen/templates — সব document template
// ================================================================
router.get("/templates", async (req, res) => {
  const { data, error } = await supabase
    .from("doc_templates")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    // Table না থাকলে empty return
    if (error.message.includes("does not exist")) return res.json([]);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// ================================================================
// POST /api/docgen/upload — .docx template upload + {{}} detect
// ================================================================
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
    const { template_name, category } = req.body;
    if (!template_name) return res.status(400).json({ error: "Template নাম দিন" });

    const agencyId = req.user.agency_id || "a0000000-0000-0000-0000-000000000001";

    // Upload to Supabase Storage
    const fileBuffer = fs.readFileSync(req.file.path);
    const storagePath = `${agencyId}/docs/${Date.now()}_${req.file.originalname}`;
    const { error: upErr } = await supabase.storage
      .from("templates")
      .upload(storagePath, fileBuffer, { contentType: req.file.mimetype, upsert: false });

    // Parse .docx to find {{placeholders}}
    const placeholders = [];
    const content = fileBuffer.toString("utf8");
    const matches = content.match(/\{\{([^}]+)\}\}/g) || [];
    const seen = new Set();
    matches.forEach(m => {
      const key = m.replace(/\{\{|\}\}/g, "").trim();
      if (!seen.has(key)) {
        seen.add(key);
        placeholders.push({ placeholder: m, key, field: key });
      }
    });

    // Save to DB
    const { data: tmpl, error: dbErr } = await supabase
      .from("doc_templates")
      .insert({
        agency_id: agencyId,
        name: template_name,
        category: category || "translation",
        file_name: req.file.originalname,
        file_url: upErr ? req.file.path : storagePath,
        placeholders,
        total_fields: placeholders.length,
      })
      .select()
      .single();

    if (dbErr) return res.status(400).json({ error: dbErr.message });

    // Cleanup local
    if (!upErr) try { fs.unlinkSync(req.file.path); } catch {}

    res.json({ template: tmpl, placeholders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// POST /api/docgen/generate — template + student → .docx download
// Body: { template_id, student_id, format: "docx" | "pdf" }
// ================================================================
router.post("/generate", async (req, res) => {
  try {
    const { template_id, student_id, format = "docx" } = req.body;
    if (!template_id || !student_id) return res.status(400).json({ error: "template_id ও student_id দিন" });

    // Get template
    const { data: tmpl } = await supabase.from("doc_templates").select("*").eq("id", template_id).single();
    if (!tmpl) return res.status(404).json({ error: "Template পাওয়া যায়নি" });

    // Get student with related data
    const { data: student } = await supabase
      .from("students")
      .select("*, student_education(*), student_jp_exams(*), student_family(*), sponsors(*)")
      .eq("id", student_id)
      .single();
    if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

    // Decrypt sensitive fields
    const { decryptSensitiveFields } = require("../lib/crypto");
    const decrypted = decryptSensitiveFields(student);

    // Flatten student data
    const flat = flattenForDoc(decrypted);

    // Get template file buffer
    let templateBuffer;
    if (fs.existsSync(tmpl.file_url)) {
      templateBuffer = fs.readFileSync(tmpl.file_url);
    } else {
      // Supabase Storage
      const { data: dlData, error: dlErr } = await supabase.storage.from("templates").download(tmpl.file_url);
      if (dlErr || !dlData) return res.status(400).json({ error: "Template file পাওয়া যায়নি" });
      templateBuffer = Buffer.from(await dlData.arrayBuffer());
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
      // PDF: convert docx content to HTML then PDF
      try {
        const htmlPdf = require("html-pdf-node");
        // Simple approach: extract text and generate PDF
        const textContent = generateHTMLFromFlat(flat, tmpl.placeholders || []);
        const file = { content: textContent };
        const pdfBuffer = await htmlPdf.generatePdf(file, { format: "A4", margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" } });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${templateName}_${studentName}.pdf"`);
        res.send(pdfBuffer);
        return;
      } catch (pdfErr) {
        // PDF fail → send docx instead
        console.error("PDF generation failed:", pdfErr.message);
      }
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${templateName}_${studentName}.docx"`);
    res.send(outputBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// DELETE /api/docgen/templates/:id
// ================================================================
router.delete("/templates/:id", async (req, res) => {
  const { data: tmpl } = await supabase.from("doc_templates").select("file_url").eq("id", req.params.id).single();
  if (tmpl?.file_url) {
    if (fs.existsSync(tmpl.file_url)) try { fs.unlinkSync(tmpl.file_url); } catch {}
    await supabase.storage.from("templates").remove([tmpl.file_url]);
  }
  const { error } = await supabase.from("doc_templates").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

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
function resolveValue(flat, key) {
  if (!key) return "";
  if (key.includes(":")) {
    const [base, mod] = key.split(":");
    const val = String(flat[base] || "");
    if (!val) return "";
    if (["year", "month", "day"].includes(mod) && val.includes("-")) {
      const [y, m, d] = val.split("-");
      if (mod === "year") return y; if (mod === "month") return m; if (mod === "day") return (d || "").slice(0, 2);
    }
    if (["first", "last"].includes(mod)) {
      const parts = val.trim().split(/\s+/);
      if (mod === "first") return parts[0] || "";
      if (mod === "last") return parts.slice(1).join(" ") || "";
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
