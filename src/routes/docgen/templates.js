/**
 * templates.js — Doc template CRUD routes
 *
 * GET    /templates                   — list all doc templates
 * POST   /upload                      — .docx upload + {{}} placeholder detect
 * POST   /create-from-default         — clone default template → agency template
 * POST   /templates/:id/mapping       — save placeholder → field mapping
 * DELETE /templates/:id               — delete template + file
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { upload } = require("./_shared");

const router = express.Router();
router.use(auth);

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
    const permanentDir = path.join(__dirname, "../../../uploads/doc-templates");
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
    // default_template_id = null → custom uploaded (user নিজে আপলোড করেছে)
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
        default_template_id: null,
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
  const srcPath = path.join(__dirname, "../../..", dt.file_url);
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Template file পাওয়া যায়নি: " + dt.file_url });

  const ext = path.extname(dt.file_name || "template.docx");
  const destName = `${req.user.agency_id}_${Date.now()}_${(dt.file_name || "template.docx").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destDir = path.join(__dirname, "../../../uploads/doc-templates");
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

  // Save as agency template — default_template_id set (ডিফল্ট থেকে তৈরি মার্কার)
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
    default_template_id: default_template_id,
  }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  res.json({ template: newTmpl, placeholders });
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

module.exports = router;
