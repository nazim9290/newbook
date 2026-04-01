/**
 * users.js — User Management API Route
 *
 * Staff user CRUD: তালিকা, আপডেট, ডিলিট, role change
 * Branch CRUD: branch তৈরি, আপডেট, ডিলিট
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/supabase");

// ═══════════════════════════════════════════════════════
// Users — স্টাফ ইউজার ম্যানেজমেন্ট
// ═══════════════════════════════════════════════════════

// ── GET /api/users — সব ইউজার তালিকা ──
router.get("/", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { data, error } = await supabase.forAgency("users", agencyId)
    .select("id, name, email, phone, role, branch, is_active, permissions, created_at, updated_at")
    .neq("role", "super_admin")
    .order("created_at", { ascending: false });

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data || []);
}));

// ── PATCH /api/users/:id — ইউজার আপডেট (role, branch, is_active, password reset) ──
router.patch("/:id", auth, asyncHandler(async (req, res) => {
  const { name, phone, role, branch, is_active, permissions, password } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;
  if (role !== undefined) update.role = role;
  if (branch !== undefined) update.branch = branch;
  if (is_active !== undefined) update.is_active = is_active;
  if (permissions !== undefined) update.permissions = typeof permissions === "string" ? permissions : JSON.stringify(permissions);

  // ── Password reset by admin ──
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: "Password কমপক্ষে ৮ অক্ষর" });
    const bcrypt = require("bcryptjs");
    update.password_hash = await bcrypt.hash(password, 12);
  }

  if (Object.keys(update).length === 0) return res.status(400).json({ error: "কিছু পরিবর্তন করুন" });

  const { data, error } = await supabase.from("users")
    .update(update)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select("id, name, email, phone, role, branch, is_active, permissions")
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// ── POST /api/users/permissions — role-wise permission matrix সেভ ──
router.post("/permissions", auth, asyncHandler(async (req, res) => {
  const { permissions } = req.body;
  if (!permissions) return res.status(400).json({ error: "permissions দিন" });
  // Agency settings-এ permission matrix save
  const { error } = await supabase.from("agencies")
    .update({ settings: JSON.stringify({ permission_matrix: permissions }) })
    .eq("id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  // প্রতিটি user-এর role অনুযায়ী permissions update
  const { data: users } = await supabase.from("users").select("id, role").eq("agency_id", req.user.agency_id);
  for (const u of (users || [])) {
    const rolePerm = permissions[u.role];
    if (rolePerm) {
      await supabase.from("users").update({ permissions: JSON.stringify(rolePerm) }).eq("id", u.id);
    }
  }
  res.json({ success: true, message: "পারমিশন সংরক্ষণ হয়েছে" });
}));

// ── DELETE /api/users/:id — ইউজার মুছে ফেলো ──
router.delete("/:id", auth, asyncHandler(async (req, res) => {
  // নিজেকে delete করতে পারবে না
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "নিজের account মুছে ফেলতে পারবেন না" });
  }
  const { error } = await supabase.from("users").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ message: "User মুছে ফেলা হয়েছে" });
}));

// ═══════════════════════════════════════════════════════
// Branches — শাখা ম্যানেজমেন্ট
// ═══════════════════════════════════════════════════════

// ── GET /api/users/branches — সব branch তালিকা ──
router.get("/branches", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const pool = supabase.pool;

  // branches table না থাকলে users table-এর branch values থেকে unique list
  // branches table check করবো, না থাকলে fallback
  try {
    const { rows: branchRows } = await pool.query(`
      SELECT DISTINCT branch FROM users WHERE agency_id = $1 AND branch IS NOT NULL AND branch != ''
      UNION
      SELECT DISTINCT branch FROM students WHERE agency_id = $1 AND branch IS NOT NULL AND branch != ''
      ORDER BY branch
    `, [agencyId]);

    // একটি query-তে সব branch-এর user/student/employee count আনা (N+1 সমস্যা সমাধান)
    const branchNames = branchRows.map(r => r.branch);
    const [userRes, studentRes, empRes] = await Promise.all([
      pool.query(
        `SELECT branch, COUNT(*)::int AS count FROM users WHERE agency_id = $1 AND branch = ANY($2) GROUP BY branch`,
        [agencyId, branchNames]
      ),
      pool.query(
        `SELECT branch, COUNT(*)::int AS count FROM students WHERE agency_id = $1 AND branch = ANY($2) GROUP BY branch`,
        [agencyId, branchNames]
      ),
      pool.query(
        `SELECT branch, COUNT(*)::int AS count FROM employees WHERE agency_id = $1 AND branch = ANY($2) GROUP BY branch`,
        [agencyId, branchNames]
      ),
    ]);
    const userMap = Object.fromEntries(userRes.rows.map(r => [r.branch, r.count]));
    const studentMap = Object.fromEntries(studentRes.rows.map(r => [r.branch, r.count]));
    const empMap = Object.fromEntries(empRes.rows.map(r => [r.branch, r.count]));
    const branches = branchNames.map(name => ({
      name,
      userCount: userMap[name] || 0,
      studentCount: studentMap[name] || 0,
      employeeCount: empMap[name] || 0,
    }));

    res.json(branches);
  } catch (err) {
    console.error("Branch list error:", err);
    res.json([]);
  }
}));

// ── GET /api/users/roles — available roles ──
router.get("/roles", auth, (req, res) => {
  res.json([
    "owner", "admin", "branch_manager", "counselor", "accountant", "teacher", "viewer",
  ]);
});

module.exports = router;
