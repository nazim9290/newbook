/**
 * super-admin.js — Super Admin agency management routes
 *
 * শুধুমাত্র super_admin role-এর user এই routes access করতে পারে।
 * Agency CRUD, platform stats, admin user তৈরি — সব এখানে।
 */

const express = require("express");
const supabase = require("../lib/supabase");
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
// POST /agencies — নতুন agency তৈরি + admin user
// ═══════════════════════════════════════════════════
router.post("/agencies", asyncHandler(async (req, res) => {
  const { name, name_bn, subdomain, phone, email, address, plan, admin_name, admin_email, admin_password, dedicated } = req.body;

  // Required fields validation
  if (!name || !subdomain || !admin_email || !admin_password) {
    return res.status(400).json({ error: "নাম, subdomain, admin email ও password আবশ্যক" });
  }
  if (admin_password.length < 8) return res.status(400).json({ error: "Password কমপক্ষে ৮ অক্ষর" });

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

  // ── Agency prefix auto-generate — নামের আদ্যক্ষর থেকে ──
  const basePrefix = generatePrefix(name);
  const prefix = await ensureUniquePrefix(basePrefix);

  // Agency তৈরি (prefix সহ)
  const settings = { dedicated: !!dedicated };
  const { data: agency, error: agencyErr } = await supabase.from("agencies")
    .insert({
      name, name_bn, subdomain, phone, email, address, prefix,
      id_counters: { student: 0, visitor: 0, payment: 0, invoice: 0, submission: 0 },
      plan: dedicated ? "dedicated" : "standard",
      settings, status: "active",
      trial_ends_at: trialEndsAt.toISOString(),
      per_student_fee: dedicated ? 0 : defaultFee,
    })
    .select().single();

  if (agencyErr) return res.status(500).json({ error: "Agency তৈরি ব্যর্থ" });

  // এই agency-র জন্য admin user তৈরি
  const password_hash = await bcrypt.hash(admin_password, 12);
  const { data: adminUser, error: userErr } = await supabase.from("users")
    .insert({ agency_id: agency.id, name: admin_name || "Admin", email: admin_email, password_hash, role: "owner", branch: "Main" })
    .select().single();

  if (userErr) return res.status(500).json({ error: "Admin user তৈরি ব্যর্থ: " + userErr.message });

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
// DELETE /agencies/:id — agency মুছে ফেলা (সাবধান!)
// ═══════════════════════════════════════════════════
router.delete("/agencies/:id", asyncHandler(async (req, res) => {
  // Demo agency মুছা যাবে না
  if (req.params.id === "a0000000-0000-0000-0000-000000000001") {
    return res.status(400).json({ error: "Demo agency মুছা যাবে না" });
  }
  const { error } = await supabase.from("agencies").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: "মুছতে ব্যর্থ" });
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
  const { per_student_fee, trial_days } = req.body;
  const value = { per_student_fee: Number(per_student_fee) || 3000, trial_days: Number(trial_days) || 14, currency: "BDT" };
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

// PATCH /default-templates/:id — template আপডেট
router.patch("/default-templates/:id", asyncHandler(async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data } = await supabase.from("default_templates").update(updates).eq("id", req.params.id).select().single();
  res.json(data);
}));

// PATCH /default-templates/:id/mapping — placeholder → system field mapping সংরক্ষণ
router.patch("/default-templates/:id/mapping", asyncHandler(async (req, res) => {
  const { placeholders } = req.body;
  if (!Array.isArray(placeholders)) return res.status(400).json({ error: "placeholders array required" });

  const { data, error } = await supabase.from("default_templates")
    .update({ template_data: JSON.stringify({ placeholders }), updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select().single();

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
