/**
 * super-admin.js — Super Admin agency management routes
 *
 * শুধুমাত্র super_admin role-এর user এই routes access করতে পারে।
 * Agency CRUD, platform stats, admin user তৈরি — সব এখানে।
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const { generatePrefix, ensureUniquePrefix } = require("../lib/idGenerator");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const router = express.Router();

// ── Multer config — ফাইল আপলোড (tmp ফোল্ডারে) ──
const upload = multer({ dest: path.join(__dirname, "../../uploads/tmp"), limits: { fileSize: 20 * 1024 * 1024 } });

// Super Admin guard — শুধু super_admin role access পাবে
const superOnly = (req, res, next) => {
  if (req.user?.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin access only" });
  }
  next();
};

// সব route-এ auth + superOnly middleware লাগবে
router.use(auth);
router.use(superOnly);

// ═══════════════════════════════════════════════════
// GET /agencies — সব agency তালিকা (student/user count সহ)
// ═══════════════════════════════════════════════════
router.get("/agencies", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("agencies").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "লোড ব্যর্থ" });

  // একটি query-তে সব agency-র student/user count আনা (N+1 সমস্যা সমাধান)
  if (data && data.length > 0) {
    const pool = supabase.pool;
    const agencyIds = data.map(a => a.id);
    const [studentRes, userRes] = await Promise.all([
      pool.query(
        `SELECT agency_id, COUNT(*)::int AS count FROM students WHERE agency_id = ANY($1) GROUP BY agency_id`,
        [agencyIds]
      ),
      pool.query(
        `SELECT agency_id, COUNT(*)::int AS count FROM users WHERE agency_id = ANY($1) GROUP BY agency_id`,
        [agencyIds]
      ),
    ]);
    const studentMap = Object.fromEntries(studentRes.rows.map(r => [r.agency_id, r.count]));
    const userMap = Object.fromEntries(userRes.rows.map(r => [r.agency_id, r.count]));
    data.forEach(a => {
      a.studentCount = studentMap[a.id] || 0;
      a.userCount = userMap[a.id] || 0;
    });
  }

  res.json(data);
}));

// ═══════════════════════════════════════════════════
// GET /agencies/:id — single agency details (students ও users সহ)
// ═══════════════════════════════════════════════════
router.get("/agencies/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("agencies").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "Agency পাওয়া যায়নি" });

  // Agency-র students ও users লিস্ট
  const { data: students } = await supabase.from("students").select("id, name_en, status").eq("agency_id", req.params.id);
  const { data: users } = await supabase.from("users").select("id, name, email, role").eq("agency_id", req.params.id);
  data.students = students || [];
  data.users = users || [];

  res.json(data);
}));

// ═══════════════════════════════════════════════════
// PATCH /agencies/:id/reset-password — agency owner password reset
// ═══════════════════════════════════════════════════
router.patch("/agencies/:id/reset-password", asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: "Password minimum 8 characters" });

  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(password, 12);

  // Agency-র owner user খুঁজে password update করো
  const { data, error } = await supabase.from("users")
    .update({ password_hash: hash, updated_at: new Date().toISOString() })
    .eq("agency_id", req.params.id)
    .eq("role", "owner")
    .select("id, name, email");

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  if (!data || data.length === 0) return res.status(404).json({ error: "Owner user পাওয়া যায়নি" });

  res.json({ success: true, message: `Password reset: ${data[0].email}` });
}));

// ═══════════════════════════════════════════════════
// POST /agencies — নতুন agency তৈরি + admin user
// ═══════════════════════════════════════════════════
router.post("/agencies", asyncHandler(async (req, res) => {
  const { name, name_bn, subdomain, phone, email, address, plan, admin_name, admin_email, admin_password, dedicated, prefix: customPrefix } = req.body;

  // Required fields validation
  if (!name || !subdomain || !admin_email || !admin_password) {
    return res.status(400).json({ error: "নাম, subdomain, admin email ও password আবশ্যক" });
  }
  if (admin_password.length < 6) return res.status(400).json({ error: "Password কমপক্ষে ৬ অক্ষর" });

  // Subdomain unique কিনা check
  const { data: existing } = await supabase.from("agencies").select("id").eq("subdomain", subdomain).single();
  if (existing) return res.status(400).json({ error: "এই subdomain ইতিমধ্যে ব্যবহৃত" });

  // Platform pricing config থেকে defaults নাও
  const { data: pricingConfig } = await supabase.from("platform_settings").select("value").eq("key", "pricing").single();
  const defaultFee = pricingConfig?.value?.per_student_fee || 3000;
  const trialDays = pricingConfig?.value?.trial_days || 14;

  // Trial end date calculate
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

  // ── Agency prefix — custom থাকলে সেটা, না থাকলে auto-generate ──
  const basePrefix = customPrefix?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) || generatePrefix(name);
  const prefix = await ensureUniquePrefix(basePrefix);

  // Agency তৈরি (prefix সহ) — email না থাকলে admin_email ব্যবহার করো
  const settings = { dedicated: !!dedicated };
  const { data: agency, error: agencyErr } = await supabase.from("agencies")
    .insert({
      name, name_bn, subdomain, phone, email: email || admin_email, address, prefix,
      id_counters: { student: 0, visitor: 0, payment: 0, invoice: 0, submission: 0 },
      plan: dedicated ? "dedicated" : "standard",
      settings, status: "active",
      trial_ends_at: trialEndsAt.toISOString(),
      per_student_fee: dedicated ? 0 : defaultFee,
    })
    .select().single();

  if (agencyErr) return res.status(500).json({ error: "Agency তৈরি ব্যর্থ" });

  // এই agency-র জন্য admin user তৈরি
  // ⚠️ Super Admin-এর email হলে duplicate owner তৈরি করো না — switch দিয়ে access পাবে
  const isSuperAdminEmail = admin_email.toLowerCase() === req.user.email?.toLowerCase();
  let adminUser = null;
  if (isSuperAdminEmail) {
    console.log(`[Agency Create] Skipping owner user — ${admin_email} is super_admin, will use switch`);
  } else {
    const password_hash = await bcrypt.hash(admin_password, 12);
    const { data, error: userErr } = await supabase.from("users")
      .insert({ agency_id: agency.id, name: admin_name || "Admin", email: admin_email, password_hash, role: "owner", branch: "Main" })
      .select().single();
    if (userErr) return res.status(500).json({ error: "Admin user তৈরি ব্যর্থ: " + userErr.message });
    adminUser = data;
  }

  // Default portal form config copy করো (demo agency থেকে)
  const { data: defaultConfigs } = await supabase.from("portal_form_config")
    .select("section_key, section_label, section_label_bn, fields, is_enabled, sort_order")
    .eq("agency_id", "a0000000-0000-0000-0000-000000000001");

  if (defaultConfigs && defaultConfigs.length > 0) {
    const newConfigs = defaultConfigs.map(c => ({ ...c, agency_id: agency.id }));
    await supabase.from("portal_form_config").insert(newConfigs);
  }

  res.status(201).json({ agency, admin: { id: adminUser.id, name: adminUser.name, email: adminUser.email } });
}));

// ═══════════════════════════════════════════════════
// PATCH /agencies/:id — agency update (name, plan, status etc.)
// ═══════════════════════════════════════════════════
router.patch("/agencies/:id", asyncHandler(async (req, res) => {
  const { name, name_bn, phone, email, address, plan, status, settings } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (name_bn !== undefined) updates.name_bn = name_bn;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (address !== undefined) updates.address = address;
  if (plan !== undefined) updates.plan = plan;
  if (status !== undefined) updates.status = status;
  if (settings !== undefined) updates.settings = settings;

  const { data, error } = await supabase.from("agencies").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: "আপডেট ব্যর্থ" });
  res.json(data);
}));

// ═══════════════════════════════════════════════════
// DELETE /agencies/:id — agency ও সব related data মুছে ফেলা (সাবধান!)
// ═══════════════════════════════════════════════════
router.delete("/agencies/:id", asyncHandler(async (req, res) => {
  const id = req.params.id;
  // Demo agency মুছা যাবে না
  if (id === "a0000000-0000-0000-0000-000000000001") {
    return res.status(400).json({ error: "Demo agency মুছা যাবে না" });
  }

  // ── Related tables আগে delete (FK constraint avoid) ──
  // Actual table names (renamed): student_fees→fee_items, student_payments→payments,
  // school_submissions→submissions, partners→partner_agencies, inventory_items→inventory,
  // hr_employees→employees, hr_salary→salary_history
  const tables = [
    "activity_log", "communications", "calendar_events", "tasks",
    "attendance", "student_jp_exams", "student_education", "student_family",
    "sponsors", "fee_items", "payments", "documents",
    "batch_students", "class_tests", "class_test_scores",
    "submissions", "excel_templates", "doc_types",
    "portal_form_config", "ocr_usage", "partner_students",
    "visitors", "students", "schools", "batches", "agents", "partner_agencies",
    "inventory", "employees", "salary_history",
    "branches", "users",
  ];

  for (const table of tables) {
    try {
      await supabase.from(table).delete().eq("agency_id", id);
    } catch (err) {
      // কিছু table-এ agency_id column না থাকতে পারে — skip
      console.log(`[Agency Delete] ${table}: ${err.message || "skipped"}`);
    }
  }

  // Agency নিজে delete
  const { error } = await supabase.from("agencies").delete().eq("id", id);
  if (error) {
    console.error("[Agency Delete] Final:", error.message);
    return res.status(500).json({ error: "মুছতে ব্যর্থ: " + error.message });
  }
  console.log(`[Agency Delete] Agency ${id} and all related data deleted`);
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════
// GET /stats — overall platform stats (agency, student, user count)
// ═══════════════════════════════════════════════════
router.get("/stats", asyncHandler(async (req, res) => {
  const { data: agencies } = await supabase.from("agencies").select("id, plan, status");
  const { data: students } = await supabase.from("students").select("id");
  const { data: users } = await supabase.from("users").select("id");

  res.json({
    totalAgencies: (agencies || []).length,
    activeAgencies: (agencies || []).filter(a => a.status === "active").length,
    totalStudents: (students || []).length,
    totalUsers: (users || []).length,
    planBreakdown: {
      free: (agencies || []).filter(a => a.plan === "free").length,
      starter: (agencies || []).filter(a => a.plan === "starter").length,
      pro: (agencies || []).filter(a => a.plan === "pro").length,
      enterprise: (agencies || []).filter(a => a.plan === "enterprise").length,
    }
  });
}));

// ══════════════════════════════════════
// Platform Pricing Settings
// ══════════════════════════════════════

// GET /pricing — বর্তমান pricing config
router.get("/pricing", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("platform_settings").select("*").eq("key", "pricing").single();
  res.json(data?.value || { per_student_fee: 3000, trial_days: 14, currency: "BDT" });
}));

// PATCH /pricing — pricing config আপডেট
router.patch("/pricing", asyncHandler(async (req, res) => {
  const { per_student_fee, trial_days, ocr_credit_price } = req.body;
  const value = {
    per_student_fee: Number(per_student_fee) || 3000,
    trial_days: Number(trial_days) || 14,
    ocr_credit_price: Number(ocr_credit_price) || 5,
    currency: "BDT",
  };
  await supabase.from("platform_settings").upsert({ key: "pricing", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  res.json({ success: true, pricing: value });
}));

// GET /billing — সব agency-র billing summary
router.get("/billing", asyncHandler(async (req, res) => {
  const { data: agencies } = await supabase.from("agencies").select("id, name, subdomain, plan, per_student_fee, total_billed, total_paid, trial_ends_at, status, settings");
  const { data: records } = await supabase.from("billing_records").select("*").order("created_at", { ascending: false });

  const summary = (agencies || []).map(a => {
    const agencyRecords = (records || []).filter(r => r.agency_id === a.id);
    const isDedicated = a.settings?.dedicated;
    const trialActive = a.trial_ends_at && new Date(a.trial_ends_at) > new Date();
    return {
      ...a, isDedicated, trialActive,
      billedCount: agencyRecords.length,
      pendingAmount: agencyRecords.filter(r => r.status === "pending").reduce((s, r) => s + (r.amount || 0), 0),
    };
  });

  res.json(summary);
}));

// PATCH /agencies/:id/fee — agency-র per student fee পরিবর্তন
router.patch("/agencies/:id/fee", asyncHandler(async (req, res) => {
  const { per_student_fee } = req.body;
  const { data, error } = await supabase.from("agencies")
    .update({ per_student_fee: Number(per_student_fee) || 3000 })
    .eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: "আপডেট ব্যর্থ" });
  res.json(data);
}));

// ═══════════════════════════════════════════════════
// OCR Credits — SuperAdmin credit management
// ═══════════════════════════════════════════════════

// POST /agencies/:id/credits — agency-তে OCR credit যোগ
router.post("/agencies/:id/credits", asyncHandler(async (req, res) => {
  const { amount, description } = req.body;
  const credits = Math.max(0, Number(amount) || 0);
  if (credits <= 0) return res.status(400).json({ error: "সঠিক credit পরিমাণ দিন" });

  // বর্তমান balance আনো
  const { data: agency } = await supabase.from("agencies").select("ocr_credits, name").eq("id", req.params.id).single();
  if (!agency) return res.status(404).json({ error: "Agency পাওয়া যায়নি" });

  const newBalance = (agency.ocr_credits || 0) + credits;

  // Agency balance আপডেট
  await supabase.from("agencies").update({ ocr_credits: newBalance }).eq("id", req.params.id);

  // Transaction log — credit add record
  await supabase.from("ocr_credit_log").insert({
    agency_id: req.params.id, amount: credits, balance_after: newBalance,
    type: "topup", description: description || `SuperAdmin credit topup: ${credits}`,
    created_by: req.user.id,
  });

  res.json({ success: true, credits: newBalance, agency: agency.name });
}));

// GET /agencies/:id/ocr-usage — agency-র OCR usage history
router.get("/agencies/:id/ocr-usage", asyncHandler(async (req, res) => {
  const { data: usage } = await supabase.from("ocr_usage")
    .select("*").eq("agency_id", req.params.id)
    .order("created_at", { ascending: false }).limit(200);
  const { data: creditLog } = await supabase.from("ocr_credit_log")
    .select("*").eq("agency_id", req.params.id)
    .order("created_at", { ascending: false }).limit(200);
  res.json({ usage: usage || [], creditLog: creditLog || [] });
}));

// GET /ocr-summary — সব agency-র OCR credit summary
router.get("/ocr-summary", asyncHandler(async (req, res) => {
  const { data: agencies } = await supabase.from("agencies")
    .select("id, name, subdomain, ocr_credits, status");
  // প্রতি agency-র মোট scan count
  const { data: usageCounts } = await supabase.from("ocr_usage")
    .select("agency_id").then(() => null).catch(() => null);

  // Simple approach — agency list with credits
  res.json((agencies || []).map(a => ({
    ...a, total_scans: 0, // frontend-এ count করবে usage API থেকে
  })));
}));

// ═══════════════════════════════════════════════════
// Default Templates — গ্লোবাল টেমপ্লেট ম্যানেজমেন্ট
// ═══════════════════════════════════════════════════

// GET /default-templates — সব default template list
router.get("/default-templates", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("default_templates").select("*").order("sort_order");
  res.json(data || []);
}));

// POST /default-templates — নতুন template আপলোড (multer file upload সহ)
// .docx ফাইল হলে {{placeholder}} detect করে template_data-তে সংরক্ষণ করে
router.post("/default-templates", upload.single("file"), asyncHandler(async (req, res) => {
  const { name, name_bn, description, category, sub_category, country } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  let file_url = null, file_name = null;
  if (req.file) {
    // uploads/default-templates/ ফোল্ডার auto-create
    const destDir = path.join(__dirname, "../../uploads/default-templates");
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const ext = path.extname(req.file.originalname);
    const dest = path.join(destDir, `${Date.now()}${ext}`);
    fs.renameSync(req.file.path, dest);
    file_url = `/uploads/default-templates/${path.basename(dest)}`;
    file_name = req.file.originalname;
  }

  // ── .docx ফাইল থেকে {{placeholder}} detect ──
  let placeholders = [];
  if (file_url && (file_name || "").endsWith(".docx")) {
    try {
      const AdmZip = require("adm-zip");
      const fullPath = path.join(__dirname, "../..", file_url);
      const zip = new AdmZip(fullPath);
      const entries = zip.getEntries();
      const foundKeys = new Set();

      entries.forEach(entry => {
        if (entry.entryName.endsWith(".xml")) {
          let content = entry.getData().toString("utf8");
          // XML tag সরিয়ে clean {{placeholders}} খোঁজা
          const cleaned = content.replace(/<[^>]+>/g, "");
          const matches = cleaned.match(/\{\{([^}]+)\}\}/g) || [];
          matches.forEach(m => {
            const key = m.replace(/[{}]/g, "").trim();
            if (key && !foundKeys.has(key)) {
              foundKeys.add(key);
              placeholders.push({ key, placeholder: m, field: "" });
            }
          });
        }
      });
    } catch (err) {
      console.error("[Default Template] Placeholder detection failed:", err.message);
    }
  }

  // template_data-তে placeholders সংরক্ষণ
  const templateData = placeholders.length > 0 ? { placeholders } : null;

  const { data } = await supabase.from("default_templates").insert({
    name, name_bn, description, category: category || "excel", sub_category, country: country || "Japan",
    file_url, file_name,
    template_data: templateData ? JSON.stringify(templateData) : null,
  }).select().single();

  res.json(data);
}));

// PATCH /default-templates/:id/mapping — placeholder → system field mapping সংরক্ষণ
// ⚠️ এই route /:id route-এর আগে থাকতে হবে — না হলে /:id catch করে ফেলে
router.patch("/default-templates/:id/mapping", asyncHandler(async (req, res) => {
  let { placeholders } = req.body || {};
  // Frontend কখনো string হিসেবে পাঠাতে পারে — parse করে নাও
  if (typeof placeholders === "string") {
    try { placeholders = JSON.parse(placeholders); } catch { /* ignore */ }
  }
  if (!Array.isArray(placeholders)) return res.status(400).json({ error: "placeholders array required" });

  const { data, error } = await supabase.from("default_templates")
    .update({ template_data: JSON.stringify({ placeholders }), updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: "Mapping সংরক্ষণ ব্যর্থ" });
  res.json(data);
}));

// PATCH /default-templates/:id — template আপডেট (file re-upload + placeholder re-detect)
router.patch("/default-templates/:id", upload.single("file"), asyncHandler(async (req, res) => {
  const updates = { updated_at: new Date().toISOString() };

  // Text fields update
  ["name", "name_bn", "description", "category", "sub_category", "country"].forEach(k => {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  });

  // ── নতুন file upload হলে — file save + placeholder re-detect ──
  if (req.file) {
    const destDir = path.join(__dirname, "../../uploads/default-templates");
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const ext = path.extname(req.file.originalname);
    const dest = path.join(destDir, `${Date.now()}${ext}`);
    fs.renameSync(req.file.path, dest);
    updates.file_url = `/uploads/default-templates/${path.basename(dest)}`;
    updates.file_name = req.file.originalname;

    // .docx হলে placeholder detect
    if (req.file.originalname.endsWith(".docx")) {
      try {
        const AdmZip = require("adm-zip");
        const zip = new AdmZip(dest);
        const foundKeys = new Set();
        const placeholders = [];

        zip.getEntries().forEach(entry => {
          if (entry.entryName.endsWith(".xml")) {
            const cleaned = entry.getData().toString("utf8").replace(/<[^>]+>/g, "");
            const matches = cleaned.match(/\{\{([^}]+)\}\}/g) || [];
            matches.forEach(m => {
              const key = m.replace(/[{}]/g, "").trim();
              if (key && !foundKeys.has(key)) {
                foundKeys.add(key);
                placeholders.push({ key, placeholder: m, field: "" });
              }
            });
          }
        });

        if (placeholders.length > 0) {
          updates.template_data = JSON.stringify({ placeholders });
        }
      } catch (err) { console.error("[Template] Placeholder detect failed:", err.message); }
    }
  }

  const { data } = await supabase.from("default_templates").update(updates).eq("id", req.params.id).select().single();
  res.json(data);
}));

// ═══════════════════════════════════════════════════
// PDF Templates — fillable PDFs (visa form etc.) — TWO modes:
//   A) AcroForm fillable PDF — named form fields filled by name
//   B) Text placeholder PDF — literal {{key}} text in the PDF, replaced at generate time
//
// Workflow:
//   1. Admin opens PDF in any editor (PDFescape / LibreOffice / Acrobat) and either
//      (A) adds named form fields, OR (B) types {{student.name_en}}-style placeholders.
//   2. Uploads here — backend detects whichever it finds (or both).
//   3. Admin maps each detected field/placeholder → system variable key.
//      For B, the placeholder text itself can BE the variable key (no mapping needed).
//   4. Generate fills AcroForm fields and/or replaces placeholder text in-place.
//
// Stored as default_templates with category='pdf'.
// template_data: {
//   type: "pdf",
//   fields: [{name, type}],         // AcroForm fields  (type: "TextField" / "CheckBox" / ...)
//   placeholders: [keys...],        // unique {{...}} keys
//   mappings: {fieldName: "student.name_en:upper"},
//   stage_visibility: [...]
// }
// ═══════════════════════════════════════════════════

const { PDFDocument: _PDFDocPDFTpl } = require("pdf-lib");
const { scanPdfPlaceholders, uniqueKeys: _phUniqueKeys } = require("../lib/pdfPlaceholders");

// POST /default-templates/pdf — Upload a PDF; detect AcroForm fields and/or {{placeholder}} text.
router.post("/default-templates/pdf", upload.single("file"), asyncHandler(async (req, res) => {
  const { name, name_bn, description, sub_category, country, stage_visibility } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  if (!req.file) return res.status(400).json({ error: "PDF file required" });

  const destDir = path.join(__dirname, "../../uploads/default-templates");
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Save PDF
  const pdfDest = path.join(destDir, `${Date.now()}_${req.file.originalname.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  fs.renameSync(req.file.path, pdfDest);
  const file_url = `/uploads/default-templates/${path.basename(pdfDest)}`;

  const pdfBytes = fs.readFileSync(pdfDest);

  // (A) Parse AcroForm fields with pdf-lib
  const fields = [];
  try {
    const pdfDoc = await _PDFDocPDFTpl.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    for (const f of form.getFields()) {
      fields.push({
        name: f.getName(),
        type: f.constructor.name.replace(/^PDF/, ""),  // "TextField" / "CheckBox" / "Dropdown" / etc.
      });
    }
  } catch (err) {
    console.error("[PDF Template] AcroForm parse failed:", err.message);
    // non-fatal — placeholder mode may still work
  }

  // (B) Scan for {{...}} text placeholders
  let placeholders = [];
  try {
    const found = await scanPdfPlaceholders(pdfBytes);
    placeholders = _phUniqueKeys(found);
  } catch (err) {
    console.error("[PDF Template] Placeholder scan failed:", err.message);
  }

  if (fields.length === 0 && placeholders.length === 0) {
    return res.status(400).json({
      error: "এই PDF-এ form field বা {{placeholder}} text কিছুই পাওয়া যায়নি — PDF-এ {{student.name_en}}-এর মতো placeholder টাইপ করুন অথবা form field বসান",
    });
  }

  // For consistent UI, expose placeholders as fields too (type: "Placeholder")
  const allFields = [
    ...fields,
    ...placeholders.filter(k => !fields.some(f => f.name === k)).map(k => ({ name: k, type: "Placeholder" })),
  ];

  const stages = (() => {
    if (!stage_visibility) return [];
    if (Array.isArray(stage_visibility)) return stage_visibility;
    try { return JSON.parse(stage_visibility); } catch { return [stage_visibility]; }
  })();

  const td = {
    type: "pdf",
    fields: allFields,
    placeholders,
    mappings: {},
    stage_visibility: stages,
  };

  const { data: row } = await supabase.from("default_templates").insert({
    name, name_bn, description,
    category: "pdf",
    sub_category: sub_category || null,
    country: country || "Japan",
    file_url, file_name: req.file.originalname,
    template_data: JSON.stringify(td),
  }).select().single();

  res.json(row);
}));

// PATCH /default-templates/:id/pdf-mapping — save field-name → system-variable mappings
router.patch("/default-templates/:id/pdf-mapping", asyncHandler(async (req, res) => {
  let { mappings, stage_visibility } = req.body || {};
  if (typeof mappings === "string") { try { mappings = JSON.parse(mappings); } catch {} }
  if (typeof mappings !== "object" || Array.isArray(mappings) || mappings === null) {
    return res.status(400).json({ error: "mappings object required" });
  }

  // Read existing template_data to preserve fields list
  const { data: existing } = await supabase.from("default_templates").select("template_data").eq("id", req.params.id).single();
  if (!existing) return res.status(404).json({ error: "Template not found" });
  const td = (typeof existing.template_data === "string" ? JSON.parse(existing.template_data) : existing.template_data) || {};

  td.mappings = mappings;
  if (Array.isArray(stage_visibility)) td.stage_visibility = stage_visibility;

  const { data, error } = await supabase.from("default_templates")
    .update({ template_data: JSON.stringify(td), updated_at: new Date().toISOString() })
    .eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: "Mapping সংরক্ষণ ব্যর্থ" });
  res.json(data);
}));

// DELETE /default-templates/:id — template মুছে ফেলা
router.delete("/default-templates/:id", asyncHandler(async (req, res) => {
  // ফাইল থাকলে ডিস্ক থেকে মুছো
  const { data: tpl } = await supabase.from("default_templates").select("file_url").eq("id", req.params.id).single();
  if (tpl?.file_url) {
    const filePath = path.join(__dirname, "../../", tpl.file_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await supabase.from("default_templates").delete().eq("id", req.params.id);
  res.json({ success: true });
}));

module.exports = router;
