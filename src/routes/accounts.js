const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET /api/accounts/income
router.get("/income", async (req, res) => {
  const { month, branch } = req.query;
  let query = supabase.from("income").select("*, students(name_en)").order("date", { ascending: false });
  if (month) query = query.ilike("date", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/accounts/income
router.post("/income", async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("income").insert(record).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/accounts/expenses
router.get("/expenses", async (req, res) => {
  const { month, branch } = req.query;
  let query = supabase.from("expenses").select("*").order("date", { ascending: false });
  if (month) query = query.ilike("date", `${month}%`);
  if (branch && branch !== "All") query = query.eq("branch", branch);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/accounts/expenses
router.post("/expenses", async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("expenses").insert(record).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/accounts/payments — student fee payments
router.get("/payments", async (req, res) => {
  const { student_id } = req.query;
  let query = supabase.from("payments").select("*, students(name_en)").order("date", { ascending: false });
  if (student_id) query = query.eq("student_id", student_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/accounts/payments
router.post("/payments", async (req, res) => {
  const record = { ...req.body, agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  const { data, error } = await supabase.from("payments").insert(record).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
