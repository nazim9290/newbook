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
const supabase = require("../lib/db");
const { logActivity } = require("../lib/activityLog");

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
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }

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

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "create", module: "partners", recordId: data.id, description: `পার্টনার তৈরি: ${data.name}`, ip: req.ip }).catch(() => {});
  res.status(201).json(data);
}));

// ── PATCH /api/partners/:id — partner আপডেট ──
router.patch("/:id", auth, asyncHandler(async (req, res) => {
  // ── Optimistic Lock — concurrent edit protection ──
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("partner_agencies").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন", code: "CONFLICT" });
    }
  }

  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("partner_agencies")
    .update(updates)
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id)
    .select().single();

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  logActivity({ agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "partners", recordId: req.params.id, description: `পার্টনার আপডেট: ${data.name}`, ip: req.ip }).catch(() => {});
  res.json(data);
}));

// ── DELETE /api/partners/:id — partner মুছে ফেলো ──
router.delete("/:id", auth, asyncHandler(async (req, res) => {
  const { error } = await supabase.from("partner_agencies")
    .delete()
    .eq("id", req.params.id)
    .eq("agency_id", req.user.agency_id);

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ message: "পার্টনার মুছে ফেলা হয়েছে" });
}));

// ── GET /api/partners/:id/students — partner-এর students ──
router.get("/:id/students", auth, asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("partner_students")
    .select("*, students(id, name_en, name_bn, phone, status, country)")
    .eq("partner_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
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

  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

module.exports = router;
