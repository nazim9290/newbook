/**
 * branches.js — Branch Management API
 *
 * এজেন্সির শাখা CRUD — ঠিকানা, ফোন, ম্যানেজার সহ।
 * Excel system variable-এ branch address ব্যবহার হয়।
 */

const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const router = express.Router();
router.use(auth);

// GET /api/branches — সব branch তালিকা
router.get("/", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("branches")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("is_hq", { ascending: false }); // HQ আগে
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  res.json(data || []);
}));

// GET /api/branches/:id
router.get("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("branches")
    .select("*").eq("id", req.params.id).eq("agency_id", req.user.agency_id).single();
  if (error) return res.status(404).json({ error: "Branch পাওয়া যায়নি" });
  res.json(data);
}));

// POST /api/branches — নতুন branch
router.post("/", asyncHandler(async (req, res) => {
  const { name, name_bn, city, address, address_bn, phone, email, manager, is_hq } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Branch নাম দিন" });

  const { data, error } = await supabase.from("branches").insert({
    agency_id: req.user.agency_id,
    name: name.trim(), name_bn, city, address, address_bn,
    phone, email, manager, is_hq: !!is_hq,
  }).select().single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: error.message?.includes("unique") ? "এই নামে branch আছে" : "সার্ভার ত্রুটি" }); }
  res.status(201).json(data);
}));

// PATCH /api/branches/:id
router.patch("/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("branches")
    .update(req.body).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json(data);
}));

// DELETE /api/branches/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("branches")
    .delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি" });
  res.json({ success: true });
}));

// GET /api/branches/by-name/:name — নাম দিয়ে branch খুঁজো (Excel system var-এ ব্যবহার)
router.get("/by-name/:name", asyncHandler(async (req, res) => {
  const { data } = await supabase.from("branches")
    .select("*").eq("agency_id", req.user.agency_id).eq("name", req.params.name).single();
  res.json(data || null);
}));

module.exports = router;
