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
const router = express.Router();

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

  // প্রতিটি agency-র student/user count বের করো
  for (const agency of data) {
    const { data: students } = await supabase.from("students").select("id").eq("agency_id", agency.id);
    const { data: users } = await supabase.from("users").select("id").eq("agency_id", agency.id);
    agency.studentCount = (students || []).length;
    agency.userCount = (users || []).length;
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

module.exports = router;
