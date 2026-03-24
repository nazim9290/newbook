const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const { encryptSensitiveFields, decryptSensitiveFields, decryptMany } = require("../lib/crypto");

const router = express.Router();
router.use(auth);

// GET /api/students — list with search + filters
router.get("/", async (req, res) => {
  const { search, status, country, batch, school, branch, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase.from("students").select("*", { count: "exact" });

  if (search) {
    query = query.or(`name_en.ilike.%${search}%,phone.ilike.%${search}%,id.ilike.%${search}%`);
  }
  if (status && status !== "All") query = query.eq("status", status);
  if (country && country !== "All") query = query.eq("country", country);
  if (batch && batch !== "All") query = query.eq("batch", batch);
  if (school && school !== "All") query = query.eq("school", school);
  if (branch && branch !== "All") query = query.eq("branch", branch);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Decrypt sensitive fields before sending to frontend
  res.json({ data: decryptMany(data), total: count, page: +page, limit: +limit });
});

// GET /api/students/:id — single student with related data
router.get("/:id", async (req, res) => {
  const { data: student, error } = await supabase
    .from("students")
    .select(`
      *,
      education(*),
      employment(*),
      jp_study(*),
      jp_exams(*),
      sponsor(*),
      payments(*),
      documents(*)
    `)
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: "স্টুডেন্ট পাওয়া যায়নি" });

  // Decrypt student + sponsor sensitive fields
  const decrypted = decryptSensitiveFields(student);
  if (decrypted.sponsor) {
    decrypted.sponsor = decryptSensitiveFields(decrypted.sponsor);
  }
  res.json(decrypted);
});

// POST /api/students — create
router.post("/", async (req, res) => {
  // Encrypt sensitive fields before saving
  const encrypted = encryptSensitiveFields(req.body);

  const { data, error } = await supabase
    .from("students")
    .insert(encrypted)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(decryptSensitiveFields(data));
});

// PATCH /api/students/:id — update
router.patch("/:id", async (req, res) => {
  // Encrypt sensitive fields before saving
  const encrypted = encryptSensitiveFields({ ...req.body, updated_at: new Date().toISOString() });

  const { data, error } = await supabase
    .from("students")
    .update(encrypted)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(decryptSensitiveFields(data));
});

// DELETE /api/students/:id
router.delete("/:id", async (req, res) => {
  const { error } = await supabase.from("students").delete().eq("id", req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/students/:id/payments — add payment
router.post("/:id/payments", async (req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .insert({ ...req.body, student_id: req.params.id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
