const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");

const router = express.Router();
router.use(auth);

// GET /api/hr/employees
router.get("/employees", async (req, res) => {
  const { status, branch } = req.query;
  let query = supabase.from("employees").select("*").order("name");
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(decryptMany(data));
});

// POST /api/hr/employees
router.post("/employees", async (req, res) => {
  const { data, error } = await supabase.from("employees").insert(encryptSensitiveFields(req.body)).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(decryptSensitiveFields(data));
});

// PATCH /api/hr/employees/:id
router.patch("/employees/:id", async (req, res) => {
  const { data, error } = await supabase.from("employees").update(encryptSensitiveFields(req.body)).eq("id", req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(decryptSensitiveFields(data));
});

// GET /api/hr/salary?employee_id=xxx&month=2026-03
router.get("/salary", async (req, res) => {
  const { employee_id, month } = req.query;
  let query = supabase.from("salary_history").select("*, employees(name)").order("paid_date", { ascending: false });
  if (employee_id) query = query.eq("employee_id", employee_id);
  if (month) query = query.eq("month", month);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/hr/salary — pay salary
router.post("/salary", async (req, res) => {
  const { data, error } = await supabase.from("salary_history").insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
