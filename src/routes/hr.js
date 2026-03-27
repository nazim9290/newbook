const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");
const { checkPermission } = require("../middleware/checkPermission");

const router = express.Router();
router.use(auth);

// GET /api/hr/employees
router.get("/employees", checkPermission("hr", "read"), asyncHandler(async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("employees").select("*").order("name");
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(decryptMany(data));
}));

// POST /api/hr/employees
router.post("/employees", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("employees").insert(encryptSensitiveFields(record)).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(decryptSensitiveFields(data));
}));

// PATCH /api/hr/employees/:id
router.patch("/employees/:id", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("employees").update(encryptSensitiveFields(req.body)).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(decryptSensitiveFields(data));
}));

// GET /api/hr/salary?employee_id=xxx&month=2026-03
router.get("/salary", checkPermission("hr", "read"), asyncHandler(async (req, res) => {
  const { employee_id, month } = req.query;
  let query = supabase.from("salary_history").select("*, employees(name)").order("paid_date", { ascending: false });
  if (employee_id) query = query.eq("employee_id", employee_id);
  if (month) query = query.eq("month", month);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data);
}));

// POST /api/hr/salary — pay salary
router.post("/salary", checkPermission("hr", "write"), asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("salary_history").insert(req.body).select().single();
  if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.status(201).json(data);
}));

module.exports = router;
