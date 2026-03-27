/**
 * partners.js — পার্টনার এজেন্সি (B2B) API Route
 *
 * অন্য এজেন্সি থেকে আসা student-দের tracking — CRUD
 * partner_agencies table + partner_students join table
 */

const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const supabase = require("../lib/supabase");

// ── GET /api/partners — সব partner এজেন্সি + student count + revenue ──
router.get("/", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { search } = req.query;

  let q = supabase.forAgency("partner_agencies", agencyId)
    .select("*")
    .order("created_at", { ascending: false });

  if (search) {
    q = q.or(`name.ilike.%${search}%,contact_person.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // প্রতিটি partner-এর student count ও revenue — join query
  const pool = supabase.pool;
  const statsRes = await pool.query(`
    SELECT
      ps.partner_id,
      COUNT(*)::int AS student_count,
      COALESCE(SUM(ps.fee), 0)::numeric AS total_fee,
      COALESCE(SUM(ps.paid), 0)::numeric AS total_paid
    FROM partner_students ps
    JOIN partner_agencies pa ON pa.id = ps.partner_id
    WHERE pa.agency_id = $1
    GROUP BY ps.partner_id
  `, [agencyId]);

  // stats merge
  const statsMap = {};
  statsRes.rows.forEach(r => { statsMap[r.partner_id] = r; });

  const enriched = (data || []).map(p => {
    const stats = statsMap[p.id] || { student_count: 0, total_fee: 0, total_paid: 0 };
    return {
      ...p,
      studentCount: stats.student_count,
      revenue: Number(stats.total_paid),
      due: Number(stats.total_fee) - Number(stats.total_paid),
    };
  });

  res.json(enriched);
}));

// ── POST /api/partners — নতুন partner তৈরি ──
router.post("/", auth, asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const { name, contact_person, phone, email, address, services, commission_rate, notes } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: "নাম দিন" });

  const { data, error } = await supabase.from("partner_agencies").insert({
    agency_id: agencyId,
    name: name.trim(),
    contact_person: contact_person || "",
    phone: phone || "",
    email: email || "",
    address: address || "",
    services: services || [],
    commission_rate: commission_rate || 0,
    notes: notes || "",
    status: "active",
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
}));

// ── PATCH /api/partners/:id — partner আপডেট ──
router.patch("/:id", auth, asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("partner_agencies")
    .update(req.body)
    .eq("id", req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}));

// ── DELETE /api/partners/:id — partner মুছে ফেলো ──
router.delete("/:id", auth, asyncHandler(async (req, res) => {
  const { error } = await supabase.from("partner_agencies")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: "পার্টনার মুছে ফেলা হয়েছে" });
}));

// ── GET /api/partners/:id/students — partner-এর students ──
router.get("/:id/students", auth, asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("partner_students")
    .select("*, students(id, name_en, name_bn, phone, status, country)")
    .eq("partner_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
}));

// ── POST /api/partners/:id/students — partner-এ student যোগ ──
router.post("/:id/students", auth, asyncHandler(async (req, res) => {
  const { student_id, student_name, fee, paid, status, notes } = req.body;

  const { data, error } = await supabase.from("partner_students").insert({
    partner_id: req.params.id,
    student_id: student_id || null,
    student_name: student_name || "",
    fee: fee || 0,
    paid: paid || 0,
    status: status || "active",
    notes: notes || "",
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
}));

module.exports = router;
