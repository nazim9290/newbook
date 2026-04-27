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
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { upload } = require("./_shared");
const { decryptSensitiveFields } = require("../../lib/crypto");
const { flattenForDoc } = require("../../lib/docgen/studentFlatten");

const router = express.Router();
router.use(auth);

// ================================================================
// GET /api/docgen/preview-data?student_id=X
// Returns flat student object — same shape as generate.js feeds to
// .docx replacement, so frontend can show live preview values inside
// the Field Mapper UI.
// ================================================================
router.get("/preview-data", asyncHandler(async (req, res) => {
  try {
    const { student_id } = req.query;
    if (!student_id) return res.status(400).json({ error: "student_id দিন" });

    // 1. Tenant-scoped student fetch
    const { data: student } = await supabase
      .from("students")
      .select("*")
      .eq("id", student_id)
      .eq("agency_id", req.user.agency_id)
      .single();
    if (!student) return res.status(404).json({ error: "Student পাওয়া যায়নি" });

    // 2. Same parallel fetch pattern as generate.js — student relations + system context
    const [eduRes, examRes, famRes, sponsorRes, workRes, jpStudyRes, agencyRes, schoolRes, batchRes, branchRes] = await Promise.all([
      supabase.from("student_education").select("*").eq("student_id", student_id),
      supabase.from("student_jp_exams").select("*").eq("student_id", student_id),
      supabase.from("student_family").select("*").eq("student_id", student_id),
      supabase.from("sponsors").select("*").eq("student_id", student_id),
      supabase.from("student_work_experience").select("*").eq("student_id", student_id),
      supabase.from("student_jp_study").select("*").eq("student_id", student_id),
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
    student.work_experience = workRes.data || [];
    student.jp_study = jpStudyRes.data || [];

    const agency = agencyRes.data || {};
    const school = Array.isArray(schoolRes.data) ? schoolRes.data[0] || {} : schoolRes.data || {};
    const batch = batchRes.data || {};
    const branch = branchRes.data || {};

    // 3. Decrypt PII
    const decrypted = decryptSensitiveFields(student);

    // 4. Flatten — DON'T duplicate logic, reuse shared helper
    const flat = flattenForDoc(decrypted, { agency, school, batch, branch });

    // 5. Return flat object
    res.json({ data: flat });
  } catch (err) {
    console.error("[DocGen preview-data]", err.message);
    res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }
}));

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
  // ⚠ শুধু valid SYSTEM_FIELDS keys (frontend FieldMapper.jsx দেখুন) ব্যবহার করো।
  // Doc-specific field (Register No, BR Number ইত্যাদি) leave empty — user manually map করবে।
  const AUTO_MAP = {
    // Student profile fields — system-এ আছে
    "Name": "name_en",
    "Full Name": "name_en",
    "Sex": "gender:jp", "Gender": "gender:jp",
    "Date of Birth": "dob:jp", "DOB": "dob:jp", "Birth Date": "dob:jp",
    "Place of Birth": "birth_place", "Birth Place": "birth_place",
    "Father's Name": "father_name_en", "Father Name": "father_name_en",
    "Mother's Name": "mother_name_en", "Mother Name": "mother_name_en",
    "Permanent Address": "permanent_address",
    "Present Address": "current_address", "Current Address": "current_address",
    "Phone": "phone", "Phone No": "phone",
    "Nationality": "nationality",
    "Passport No": "passport_number", "Passport Number": "passport_number",
    "NID": "nid", "NID No": "nid",
    "Occupation": "occupation",
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
