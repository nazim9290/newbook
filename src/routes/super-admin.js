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
const { multiTenantGuard } = require("../middleware/licenseGate");
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
// License gate: blocks if max_agencies reached or license inactive (Phase 0)
// ═══════════════════════════════════════════════════
router.post("/agencies", multiTenantGuard(), asyncHandler(async (req, res) => {
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

// ── Helpers ──────────────────────────────────────────────────
// Parse tags / school_ids from body (accepts JSON string OR array).
function parseArrayField(val) {
  if (val == null || val === "") return null;
  if (Array.isArray(val)) return val;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? p : null;
  } catch { return null; }
}

// Replace junction-table rows for a template (delete-all then insert).
async function replaceTemplateSchoolLinks(templateId, schoolIds) {
  const pool = supabase.pool;
  await pool.query(`DELETE FROM default_template_schools WHERE template_id = $1`, [templateId]);
  if (Array.isArray(schoolIds) && schoolIds.length > 0) {
    const valuesSql = schoolIds.map((_, i) => `($1, $${i + 2})`).join(", ");
    await pool.query(
      `INSERT INTO default_template_schools (template_id, school_id) VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
      [templateId, ...schoolIds]
    );
  }
}

// Load { templateId: [schoolId, ...] } for a list of template ids.
async function loadTemplateSchoolMap(templateIds) {
  if (!templateIds || templateIds.length === 0) return {};
  const pool = supabase.pool;
  const { rows } = await pool.query(
    `SELECT template_id, school_id FROM default_template_schools WHERE template_id = ANY($1)`,
    [templateIds]
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.template_id]) map[r.template_id] = [];
    map[r.template_id].push(r.school_id);
  }
  return map;
}

// GET /default-templates — সব default template list (tags + school_ids সহ)
router.get("/default-templates", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("default_templates").select("*").order("sort_order");
  const list = data || [];
  const ids = list.map(t => t.id);
  const schoolMap = await loadTemplateSchoolMap(ids);
  for (const t of list) {
    t.tags = t.tags || [];
    t.school_ids = schoolMap[t.id] || [];
  }
  res.json(list);
}));

// POST /default-templates — নতুন template আপলোড (multer file upload সহ)
// .docx ফাইল হলে {{placeholder}} detect করে template_data-তে সংরক্ষণ করে
router.post("/default-templates", upload.single("file"), asyncHandler(async (req, res) => {
  const { name, name_bn, description, category, sub_category, country } = req.body;
  const tags = parseArrayField(req.body.tags) || [];
  const schoolIds = parseArrayField(req.body.school_ids) || [];
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
    tags,
    template_data: templateData ? JSON.stringify(templateData) : null,
  }).select().single();

  if (data && schoolIds.length > 0) {
    await replaceTemplateSchoolLinks(data.id, schoolIds);
    data.school_ids = schoolIds;
  } else if (data) {
    data.school_ids = [];
  }

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

  // tags column — array
  const tags = parseArrayField(req.body.tags);
  if (tags !== null) updates.tags = tags;
  // school_ids — write to junction table after the main update
  const schoolIds = parseArrayField(req.body.school_ids);

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

  if (data && schoolIds !== null) {
    await replaceTemplateSchoolLinks(data.id, schoolIds);
    data.school_ids = schoolIds;
  } else if (data) {
    const map = await loadTemplateSchoolMap([data.id]);
    data.school_ids = map[data.id] || [];
  }

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
  const tags = parseArrayField(req.body.tags) || [];
  const schoolIds = parseArrayField(req.body.school_ids) || [];
  if (!name) return res.status(400).json({ error: "Name required" });
  if (!req.file) return res.status(400).json({ error: "PDF file required" });

  const destDir = path.join(__dirname, "../../uploads/default-templates");
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Save PDF
  const pdfDest = path.join(destDir, `${Date.now()}_${req.file.originalname.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  fs.renameSync(req.file.path, pdfDest);
  const file_url = `/uploads/default-templates/${path.basename(pdfDest)}`;

  const pdfBytes = fs.readFileSync(pdfDest);

  // (A) Parse AcroForm fields with pdf-lib — also read each field's CURRENT VALUE.
  //     If the value contains {{key}}, treat it as an inline placeholder — admin typed
  //     the placeholder text directly into the field via PDFescape/Acrobat default-value.
  const fields = [];
  try {
    const pdfDoc = await _PDFDocPDFTpl.load(pdfBytes, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    for (const f of form.getFields()) {
      const typ = f.constructor.name;
      let value = "";
      try {
        if (typ === "PDFTextField")        value = f.getText() || "";
        else if (typ === "PDFCheckBox")    value = f.isChecked() ? "true" : "";
        else if (typ === "PDFDropdown")    value = (f.getSelected() || [])[0] || "";
        else if (typ === "PDFRadioGroup")  value = f.getSelected() || "";
      } catch {}
      const phMatch = value && /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(value);
      const placeholderKey = phMatch ? phMatch[1].trim() : null;
      fields.push({
        name: f.getName(),
        type: typ.replace(/^PDF/, ""),     // "TextField" / "CheckBox" / "Dropdown" / etc.
        placeholderKey,                     // null OR "Given Name" if user typed {{Given Name}} as default value
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

  // For consistent UI, expose text-overlay placeholders as fields too (type: "Placeholder").
  // AcroForm fields whose default value already contains {{key}} get a placeholderKey on the field row.
  const allFields = [
    ...fields,
    ...placeholders
      .filter(k => !fields.some(f => f.name === k || f.placeholderKey === k))
      .map(k => ({ name: k, type: "Placeholder", placeholderKey: k })),
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
    tags,
    template_data: JSON.stringify(td),
  }).select().single();

  if (row && schoolIds.length > 0) {
    await replaceTemplateSchoolLinks(row.id, schoolIds);
    row.school_ids = schoolIds;
  } else if (row) {
    row.school_ids = [];
  }

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

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIPTION & BILLING — Super-admin overrides (Master Plan Section 7.2)
// ═══════════════════════════════════════════════════════════════════════

// GET /subscriptions — সব agency-র subscription overview
router.get("/subscriptions", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT s.*, a.name AS agency_name, a.subdomain, a.email AS agency_email,
           p.code AS plan_code_name, p.name_en AS plan_name, p.monthly_price, p.annual_price
    FROM agency_subscriptions s
    JOIN agencies a ON a.id = s.agency_id
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    ORDER BY a.name
  `);
  res.json(rows || []);
}));

// POST /subscriptions/:agencyId/change-plan — super-admin force plan change
// body: { plan_code, billing_cycle? }
router.post("/subscriptions/:agencyId/change-plan", asyncHandler(async (req, res) => {
  const { plan_code, billing_cycle = "monthly" } = req.body || {};
  if (!plan_code) return res.status(400).json({ error: "plan_code দিন" });

  const { data: plan } = await supabase.from("subscription_plans").select("*").eq("code", plan_code).single();
  if (!plan) return res.status(404).json({ error: "Plan নেই" });

  const now = new Date();
  const periodEnd = new Date(now);
  if (billing_cycle === "annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  else periodEnd.setMonth(periodEnd.getMonth() + 1);

  const { data: cur } = await supabase.from("agency_subscriptions").select("plan_code, legacy_pricing").eq("agency_id", req.params.agencyId).single();

  await supabase.from("agency_subscriptions").update({
    plan_id: plan.id, plan_code: plan.code, billing_cycle, status: "active",
    current_period_start: now.toISOString(), current_period_end: periodEnd.toISOString(),
    cancel_at_period_end: false, cancelled_at: null, cancellation_reason: null,
    legacy_pricing: false, legacy_per_student_rate: null, legacy_migration_deadline: null,
    updated_at: now.toISOString(),
  }).eq("agency_id", req.params.agencyId);

  await supabase.from("agencies").update({ plan: plan.code }).eq("id", req.params.agencyId);

  await supabase.from("subscription_history").insert({
    agency_id: req.params.agencyId, event_type: "upgraded",
    from_plan_code: cur?.plan_code || (cur?.legacy_pricing ? "legacy" : null),
    to_plan_code: plan.code, triggered_by: req.user.id,
    notes: `Super-admin forced plan change to ${plan.code} (${billing_cycle})`,
  });

  const { invalidateCache } = require("../middleware/subscriptionGuard");
  invalidateCache(req.params.agencyId);
  res.json({ success: true, plan_code: plan.code, billing_cycle });
}));

// POST /subscriptions/:agencyId/extend-trial — extend trial by N days
// body: { days }
router.post("/subscriptions/:agencyId/extend-trial", asyncHandler(async (req, res) => {
  const days = Number(req.body?.days || 0);
  if (!days || days <= 0) return res.status(400).json({ error: "days > 0 দিন" });
  const { data: cur } = await supabase.from("agency_subscriptions").select("trial_ends_at, status").eq("agency_id", req.params.agencyId).single();
  const base = cur?.trial_ends_at ? new Date(cur.trial_ends_at) : new Date();
  base.setDate(base.getDate() + days);
  await supabase.from("agency_subscriptions").update({
    trial_ends_at: base.toISOString(), status: "trial",
    updated_at: new Date().toISOString(),
  }).eq("agency_id", req.params.agencyId);
  await supabase.from("subscription_history").insert({
    agency_id: req.params.agencyId, event_type: "reactivated", triggered_by: req.user.id,
    notes: `Trial extended by ${days} days → ${base.toISOString().slice(0,10)}`,
  });
  const { invalidateCache } = require("../middleware/subscriptionGuard");
  invalidateCache(req.params.agencyId);
  res.json({ success: true, trial_ends_at: base.toISOString() });
}));

// POST /subscriptions/:agencyId/suspend — manual suspend
router.post("/subscriptions/:agencyId/suspend", asyncHandler(async (req, res) => {
  await supabase.from("agency_subscriptions").update({ status: "suspended", updated_at: new Date().toISOString() }).eq("agency_id", req.params.agencyId);
  await supabase.from("subscription_history").insert({
    agency_id: req.params.agencyId, event_type: "status_changed", triggered_by: req.user.id,
    notes: "Manually suspended by super-admin",
  });
  const { invalidateCache } = require("../middleware/subscriptionGuard");
  invalidateCache(req.params.agencyId);
  res.json({ success: true });
}));

// POST /subscriptions/:agencyId/restore — manual restore from suspended/cancelled
router.post("/subscriptions/:agencyId/restore", asyncHandler(async (req, res) => {
  await supabase.from("agency_subscriptions").update({
    status: "active", cancel_at_period_end: false, cancelled_at: null, cancellation_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("agency_id", req.params.agencyId);
  await supabase.from("subscription_history").insert({
    agency_id: req.params.agencyId, event_type: "reactivated", triggered_by: req.user.id,
    notes: "Manually restored to active by super-admin",
  });
  const { invalidateCache } = require("../middleware/subscriptionGuard");
  invalidateCache(req.params.agencyId);
  res.json({ success: true });
}));

// ── Invoices (super-admin scope) ──

// GET /billing/invoices — all agencies-এর invoice list
router.get("/billing/invoices", asyncHandler(async (req, res) => {
  const { status, agency_id, limit = 100 } = req.query;
  const { rows } = await supabase.pool.query(`
    SELECT i.*, a.name AS agency_name, a.subdomain
    FROM invoices i
    JOIN agencies a ON a.id = i.agency_id
    WHERE ($1::text IS NULL OR i.status = $1)
      AND ($2::uuid IS NULL OR i.agency_id = $2)
    ORDER BY i.issue_date DESC, i.created_at DESC
    LIMIT $3
  `, [status && status !== "All" ? status : null, agency_id || null, Math.min(Number(limit) || 100, 500)]);
  res.json(rows || []);
}));

// POST /billing/invoices/generate — manual invoice generation for an agency-period
// body: { agency_id, period_start, period_end, line_items: [{ description, qty, unit_price, total }], notes? }
router.post("/billing/invoices/generate", asyncHandler(async (req, res) => {
  const { agency_id, period_start, period_end, line_items = [], notes } = req.body || {};
  if (!agency_id || !period_start || !period_end) return res.status(400).json({ error: "agency_id, period_start, period_end দিন" });
  if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: "line_items দিন" });

  const subtotal = line_items.reduce((s, i) => s + Number(i.total || 0), 0);
  const dueDate = new Date(period_end); dueDate.setDate(dueDate.getDate() + 7);

  // Generate invoice number (same logic as cron)
  const { rows: lastRows } = await supabase.pool.query(
    `SELECT invoice_number FROM invoices WHERE invoice_number LIKE $1 ORDER BY invoice_number DESC LIMIT 1`,
    [`INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-%`]
  );
  let next = 1;
  if (lastRows.length) { const n = parseInt(lastRows[0].invoice_number.split("-").pop(), 10); if (!Number.isNaN(n)) next = n + 1; }
  const invoiceNumber = `INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-${String(next).padStart(4, "0")}`;

  const { data: sub } = await supabase.from("agency_subscriptions").select("id").eq("agency_id", agency_id).single();

  const { data, error } = await supabase.from("invoices").insert({
    invoice_number: invoiceNumber, agency_id, subscription_id: sub?.id,
    period_start, period_end, issue_date: new Date().toISOString().slice(0, 10),
    due_date: dueDate.toISOString().slice(0, 10),
    subtotal, total_amount: subtotal, currency: "BDT",
    line_items, status: "sent", sent_at: new Date().toISOString(), notes,
  }).select().single();
  if (error) return res.status(500).json({ error: "Invoice তৈরি ব্যর্থ: " + error.message });

  // Auto-email — fire-and-forget (don't block API response)
  const { sendInvoiceEmail } = require("../lib/sendInvoiceEmail");
  sendInvoiceEmail(data.id).catch(e => console.error("[ManualInvoiceEmail]", e.message));

  res.json(data);
}));

// POST /billing/invoices/:id/resend — resend invoice email (super-admin)
router.post("/billing/invoices/:id/resend", asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Reset email_status so the send marks 'sent' fresh; don't reset attempts
  await supabase.pool.query(
    `UPDATE invoices SET email_status = 'pending', email_error = NULL WHERE id = $1`,
    [id]
  );
  const { sendInvoiceEmail } = require("../lib/sendInvoiceEmail");
  const result = await sendInvoiceEmail(id);
  if (result.success) return res.json({ success: true, recipient: result.recipient });
  return res.status(500).json({ error: result.error || "Resend ব্যর্থ" });
}));

// POST /billing/payments/manual — record a manual payment
// body: { agency_id, invoice_id?, amount, payment_method, transaction_id?, notes? }
router.post("/billing/payments/manual", asyncHandler(async (req, res) => {
  const { agency_id, invoice_id, amount, payment_method, transaction_id, notes } = req.body || {};
  if (!agency_id || !amount || !payment_method) return res.status(400).json({ error: "agency_id, amount, payment_method দিন" });

  const { data: payment, error } = await supabase.from("subscription_payments").insert({
    agency_id, invoice_id: invoice_id || null,
    amount: Number(amount), currency: "BDT",
    payment_method, transaction_id, status: "completed",
    paid_at: new Date().toISOString(),
    recorded_by: req.user.id, notes,
  }).select().single();
  if (error) return res.status(500).json({ error: "Payment record ব্যর্থ" });

  // If linked to invoice, update paid_amount / status
  if (invoice_id) {
    const { data: inv } = await supabase.from("invoices").select("total_amount, paid_amount").eq("id", invoice_id).single();
    if (inv) {
      const newPaid = Number(inv.paid_amount || 0) + Number(amount);
      const status = newPaid >= Number(inv.total_amount) ? "paid" : "sent";
      const updates = { paid_amount: newPaid, status, updated_at: new Date().toISOString() };
      if (status === "paid") updates.paid_at = new Date().toISOString();
      await supabase.from("invoices").update(updates).eq("id", invoice_id);
    }
  }

  res.json(payment);
}));

// POST /billing/payments/:id/refund — refund a payment (Section 11.1)
// body: { amount?, reason? } — full refund if amount omitted
router.post("/billing/payments/:id/refund", asyncHandler(async (req, res) => {
  const { amount, reason } = req.body || {};
  const { data: payment } = await supabase.from("subscription_payments").select("*").eq("id", req.params.id).maybeSingle();
  if (!payment) return res.status(404).json({ error: "Payment পাওয়া যায়নি" });
  if (payment.status === "refunded") return res.status(400).json({ error: "ইতিমধ্যে refund হয়েছে" });

  const refundAmount = Number(amount || payment.amount);
  if (refundAmount <= 0 || refundAmount > Number(payment.amount)) {
    return res.status(400).json({ error: "Invalid refund amount" });
  }
  const isFullRefund = refundAmount >= Number(payment.amount);

  // Create refund record (negative amount in subscription_payments)
  const { data: refund, error } = await supabase.from("subscription_payments").insert({
    agency_id: payment.agency_id,
    invoice_id: payment.invoice_id,
    amount: -refundAmount,                       // negative = refund
    currency: payment.currency,
    payment_method: payment.payment_method,
    transaction_id: `refund:${payment.transaction_id || payment.id}`,
    status: "completed",
    paid_at: new Date().toISOString(),
    recorded_by: req.user.id,
    notes: `Refund of ${refundAmount} from payment ${payment.id}. Reason: ${reason || "—"}`,
  }).select().single();
  if (error) { console.error("[Refund]", error.message); return res.status(500).json({ error: "Refund ব্যর্থ" }); }

  // Mark original payment as refunded (if full) or partial-refund
  await supabase.from("subscription_payments").update({
    status: isFullRefund ? "refunded" : "completed",
    notes: (payment.notes ? payment.notes + " | " : "") + `Refunded ${refundAmount} on ${new Date().toISOString().slice(0, 10)}`,
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.id);

  // Update linked invoice paid_amount
  if (payment.invoice_id) {
    const { data: inv } = await supabase.from("invoices").select("total_amount, paid_amount").eq("id", payment.invoice_id).maybeSingle();
    if (inv) {
      const newPaid = Math.max(0, Number(inv.paid_amount || 0) - refundAmount);
      const status = newPaid >= Number(inv.total_amount) ? "paid" : newPaid > 0 ? "sent" : "refunded";
      await supabase.from("invoices").update({
        paid_amount: newPaid, status,
        paid_at: status === "paid" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", payment.invoice_id);
    }
  }

  // History
  await supabase.from("subscription_history").insert({
    agency_id: payment.agency_id, event_type: "refund_issued",
    triggered_by: req.user.id,
    notes: `Refunded ${refundAmount} BDT (${isFullRefund ? "full" : "partial"})${reason ? `: ${reason}` : ""}`,
    metadata: { original_payment_id: payment.id, amount: refundAmount, reason },
  });

  res.json({ success: true, refund, original_payment_id: payment.id });
}));

// GET /billing/payments — all payments
router.get("/billing/payments", asyncHandler(async (req, res) => {
  const { agency_id, limit = 100 } = req.query;
  let q = supabase.from("subscription_payments")
    .select("*, agencies(name, subdomain)")
    .order("paid_at", { ascending: false })
    .limit(Math.min(Number(limit) || 100, 500));
  if (agency_id) q = q.eq("agency_id", agency_id);
  const { data } = await q;
  res.json(data || []);
}));

// POST /billing/cron/run — manually trigger the billing cron (testing aid)
router.post("/billing/cron/run", asyncHandler(async (req, res) => {
  const { runAllJobs } = require("../lib/billingCron");
  try {
    const result = await runAllJobs(true);
    res.json({ success: true, result });
  } catch (e) {
    console.error("[CronManualTrigger]", e.message);
    res.status(500).json({ error: "Cron run ব্যর্থ: " + e.message });
  }
}));

// GET /billing/cron/status — last run info
router.get("/billing/cron/status", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("platform_settings").select("value, updated_at").eq("key", "billing_cron_last_run").single();
  res.json(data || { value: null });
}));

// GET /metrics/mrr-sparkline?days=90 — daily MRR for sparkline chart
router.get("/metrics/mrr-sparkline", asyncHandler(async (req, res) => {
  const days = Math.min(Number(req.query.days || 90), 365);
  // Use subscription_history + agency_subscriptions snapshot to reconstruct daily MRR
  // Simpler approach: payments-based daily revenue trail
  const { rows } = await supabase.pool.query(`
    SELECT DATE(paid_at) AS day, COALESCE(SUM(amount), 0)::numeric AS revenue
    FROM subscription_payments
    WHERE status = 'completed'
      AND amount > 0
      AND paid_at >= (CURRENT_DATE - ($1 || ' days')::interval)
    GROUP BY DATE(paid_at)
    ORDER BY day ASC
  `, [days]);

  // Fill missing days with 0
  const map = {};
  rows.forEach(r => { map[String(r.day).slice(0, 10)] = Number(r.revenue || 0); });
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, revenue: map[key] || 0 });
  }
  res.json({ days, series });
}));

// GET /metrics/churn — monthly churn calculation
router.get("/metrics/churn", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE - interval '11 months'),
        date_trunc('month', CURRENT_DATE),
        '1 month'::interval
      ) AS m
    ),
    cancellations AS (
      SELECT date_trunc('month', created_at) AS m, COUNT(*)::int AS cancelled
      FROM subscription_history
      WHERE event_type IN ('cancelled', 'status_changed')
        AND notes ILIKE '%cancelled%'
        AND created_at >= CURRENT_DATE - interval '12 months'
      GROUP BY date_trunc('month', created_at)
    ),
    starts AS (
      SELECT date_trunc('month', created_at) AS m, COUNT(*)::int AS started
      FROM agency_subscriptions
      WHERE created_at >= CURRENT_DATE - interval '12 months'
      GROUP BY date_trunc('month', created_at)
    )
    SELECT
      to_char(months.m, 'YYYY-MM') AS month,
      COALESCE(c.cancelled, 0) AS cancelled,
      COALESCE(s.started, 0) AS started
    FROM months
    LEFT JOIN cancellations c ON c.m = months.m
    LEFT JOIN starts s ON s.m = months.m
    ORDER BY months.m ASC
  `);

  const total = await supabase.pool.query(`SELECT COUNT(*)::int AS total FROM agency_subscriptions WHERE legacy_pricing = false`);
  const totalSubs = total.rows[0]?.total || 0;
  const lastMonth = rows[rows.length - 1] || { cancelled: 0 };
  const churnPct = totalSubs > 0 ? (Number(lastMonth.cancelled) / totalSubs) * 100 : 0;

  res.json({
    monthly: rows,
    last_month_churn_pct: Math.round(churnPct * 10) / 10,
    total_active_tier: totalSubs,
  });
}));

// GET /metrics/conversion — trial → paid conversion rate
router.get("/metrics/conversion", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'trial') AS trialing,
      COUNT(*) FILTER (WHERE status = 'active' AND legacy_pricing = false) AS active,
      COUNT(*) FILTER (WHERE plan_id IS NOT NULL AND legacy_pricing = false) AS converted
    FROM agency_subscriptions
  `);
  const r = rows[0] || {};
  const total = Number(r.trialing || 0) + Number(r.converted || 0);
  const conversionPct = total > 0 ? (Number(r.converted || 0) / total) * 100 : 0;
  res.json({
    currently_trialing: Number(r.trialing || 0),
    currently_active: Number(r.active || 0),
    total_converted: Number(r.converted || 0),
    conversion_pct: Math.round(conversionPct * 10) / 10,
  });
}));

// GET /metrics/revenue-export.csv — full revenue CSV (BOM-prefixed)
router.get("/metrics/revenue-export.csv", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT
      p.paid_at, p.amount, p.currency, p.payment_method, p.status, p.transaction_id,
      a.name AS agency_name, a.subdomain,
      i.invoice_number
    FROM subscription_payments p
    JOIN agencies a ON a.id = p.agency_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ORDER BY p.paid_at DESC
    LIMIT 10000
  `);
  const header = "Date,Agency,Subdomain,Invoice #,Amount,Currency,Method,Status,Transaction ID";
  const csvRows = rows.map(r => [
    r.paid_at ? new Date(r.paid_at).toISOString().slice(0, 10) : "",
    `"${(r.agency_name || "").replace(/"/g, '""')}"`,
    r.subdomain || "",
    r.invoice_number || "",
    r.amount, r.currency,
    r.payment_method, r.status,
    r.transaction_id || "",
  ].join(","));
  const csv = "﻿" + header + "\n" + csvRows.join("\n");
  res.setHeader("Content-Type", "text/csv;charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="revenue_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /metrics/revenue — basic MRR/revenue calc
router.get("/metrics/revenue", asyncHandler(async (req, res) => {
  // Active subs × monthly_price
  const { rows: mrrRows } = await supabase.pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE s.status IN ('active','trial')) AS active_count,
      COALESCE(SUM(CASE WHEN s.billing_cycle = 'annual' THEN p.annual_price/12 ELSE p.monthly_price END) FILTER (WHERE s.status = 'active' AND s.legacy_pricing = false), 0) AS mrr,
      COUNT(*) FILTER (WHERE s.legacy_pricing = true) AS legacy_count,
      COUNT(*) FILTER (WHERE s.status = 'past_due') AS past_due_count,
      COUNT(*) FILTER (WHERE s.status = 'suspended') AS suspended_count,
      COUNT(*) FILTER (WHERE s.status = 'cancelled') AS cancelled_count
    FROM agency_subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
  `);

  // Plan-wise distribution
  const { rows: planDist } = await supabase.pool.query(`
    SELECT COALESCE(p.code, 'legacy') AS plan_code, COUNT(*) AS count
    FROM agency_subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    GROUP BY COALESCE(p.code, 'legacy')
  `);

  // Outstanding total
  const { rows: outRows } = await supabase.pool.query(`
    SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS outstanding
    FROM invoices WHERE status IN ('sent', 'overdue')
  `);

  // YTD revenue
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const { rows: ytdRows } = await supabase.pool.query(`
    SELECT COALESCE(SUM(amount), 0) AS ytd FROM subscription_payments WHERE status = 'completed' AND paid_at >= $1
  `, [yearStart]);

  res.json({
    mrr: Number(mrrRows[0]?.mrr || 0),
    arr: Number(mrrRows[0]?.mrr || 0) * 12,
    active_count: Number(mrrRows[0]?.active_count || 0),
    legacy_count: Number(mrrRows[0]?.legacy_count || 0),
    past_due_count: Number(mrrRows[0]?.past_due_count || 0),
    suspended_count: Number(mrrRows[0]?.suspended_count || 0),
    cancelled_count: Number(mrrRows[0]?.cancelled_count || 0),
    outstanding: Number(outRows[0]?.outstanding || 0),
    ytd_revenue: Number(ytdRows[0]?.ytd || 0),
    plan_distribution: planDist || [],
  });
}));

// ═══════════════════════════════════════════════════
// GET /integrations-overview — cross-agency BYOK status table
// Read-only audit view: which agencies have configured which services,
// when they were last validated, last errors. No credential decryption —
// shows masked metadata only.
// ═══════════════════════════════════════════════════
router.get("/integrations-overview", asyncHandler(async (req, res) => {
  const { rows } = await supabase.pool.query(`
    SELECT
      a.id AS agency_id, a.name AS agency_name, a.subdomain, a.plan,
      i.service, i.enabled, i.validated_at, i.last_error, i.updated_at,
      u.call_count AS month_usage
    FROM agencies a
    LEFT JOIN agency_integrations i ON i.agency_id = a.id
    LEFT JOIN agency_api_usage u
      ON u.agency_id = a.id AND u.service = i.service
      AND u.period = to_char(now(), 'YYYY-MM')
    WHERE a.status = 'active'
    ORDER BY a.name, i.service
  `);

  // Group by agency
  const byAgency = {};
  for (const r of rows) {
    if (!byAgency[r.agency_id]) {
      byAgency[r.agency_id] = {
        agency_id: r.agency_id,
        agency_name: r.agency_name,
        subdomain: r.subdomain,
        plan: r.plan,
        integrations: {},
      };
    }
    if (r.service) {
      byAgency[r.agency_id].integrations[r.service] = {
        enabled: r.enabled,
        validated_at: r.validated_at,
        last_error: r.last_error,
        updated_at: r.updated_at,
        month_usage: r.month_usage || 0,
      };
    }
  }

  // Also fetch this month's platform-key usage (agencies that haven't BYOK'd
  // for a service still consume the platform key — surface that too)
  const { rows: usageRows } = await supabase.pool.query(`
    SELECT u.agency_id, u.service, u.call_count
    FROM agency_api_usage u
    WHERE u.period = to_char(now(), 'YYYY-MM')
      AND NOT EXISTS (
        SELECT 1 FROM agency_integrations i
        WHERE i.agency_id = u.agency_id AND i.service = u.service AND i.enabled = true
      )
  `);
  for (const r of usageRows) {
    if (byAgency[r.agency_id]) {
      byAgency[r.agency_id].platform_usage ||= {};
      byAgency[r.agency_id].platform_usage[r.service] = r.call_count;
    }
  }

  res.json({
    period: new Date().toISOString().slice(0, 7),
    agencies: Object.values(byAgency),
  });
}));

module.exports = router;
