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

  // batch ও school এর নাম সহ fetch করো (join)
  let query = supabase.from("students").select("*, batches(name), schools(name_en)", { count: "exact" });

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

  // DB fields → frontend field mapping
  const mapped = (data || []).map(s => ({
    ...s,
    batch: s.batches?.name || s.batch || "",      // frontend batch (name) চায়
    school: s.schools?.name_en || s.school || "",  // frontend school (name) চায়
    passport: s.passport_number || "",              // frontend passport চায়
    father: s.father_name || "",
    mother: s.mother_name || "",
    created: s.created_at?.slice(0, 10) || "",
  }));

  res.json({ data: decryptMany(mapped), total: count, page: +page, limit: +limit });
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

// POST /api/students — নতুন student তৈরি
// students table-এ শুধু valid columns পাঠাও, বাকি সব ignore
const STUDENT_COLUMNS = [
  "id", "name_en", "name_bn", "name_katakana", "phone", "whatsapp", "email",
  "dob", "gender", "marital_status", "nationality", "blood_group", "nid",
  "passport_number", "passport_issue", "passport_expiry",
  "permanent_address", "current_address", "father_name", "father_name_en",
  "mother_name", "mother_name_en", "status", "country", "school_id", "batch_id",
  "intake", "visa_type", "source", "agent_id", "referral_info", "student_type",
  "counselor", "branch", "gdrive_folder_url", "photo_url", "internal_notes",
];

router.post("/", async (req, res) => {
  const body = req.body;

  // শুধু valid DB columns রাখো, বাকি সব ফেলে দাও
  const record = { agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001" };
  for (const col of STUDENT_COLUMNS) {
    if (body[col] !== undefined && body[col] !== "") record[col] = body[col];
  }

  // Frontend field → DB column mapping
  if (!record.passport_number && body.passport) record.passport_number = body.passport;
  if (!record.father_name && body.father) record.father_name = body.father;
  if (!record.mother_name && body.mother) record.mother_name = body.mother;

  const encrypted = encryptSensitiveFields(record);

  const { data, error } = await supabase
    .from("students")
    .insert(encrypted)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(decryptSensitiveFields(data));
});

// PATCH /api/students/:id — student update
router.patch("/:id", async (req, res) => {
  const body = req.body;

  // শুধু valid DB columns রাখো
  const updates = {};
  for (const col of STUDENT_COLUMNS) {
    if (body[col] !== undefined) updates[col] = body[col];
  }
  if (body.passport) updates.passport_number = body.passport;
  if (body.father) updates.father_name = body.father;
  if (body.mother) updates.mother_name = body.mother;

  const encrypted = encryptSensitiveFields(updates);

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
