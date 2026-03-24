const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const { encryptSensitiveFields, decryptMany } = require("../lib/crypto");

const router = express.Router();
router.use(auth);

// GET /api/visitors
router.get("/", async (req, res) => {
  const { search, status, branch, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase.from("visitors").select("*", { count: "exact" });

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }
  if (status && status !== "All") query = query.eq("status", status);
  if (branch && branch !== "All") query = query.eq("branch", branch);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // DB columns → frontend field names mapping
  const mapped = (data || []).map(v => ({
    ...v,
    name_en: v.name_en || v.name,        // frontend name_en চায়
    date: v.visit_date || v.date,          // frontend date চায়
    lastFollowUp: v.last_follow_up,        // frontend lastFollowUp চায়
    interested_countries: v.interested_countries || [],
    interested_intake: v.interested_intake || "",
  }));

  res.json({ data: decryptMany(mapped), total: count });
});

// POST /api/visitors
router.post("/", async (req, res) => {
  const { data, error } = await supabase.from("visitors").insert(encryptSensitiveFields(req.body)).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/visitors/:id
router.patch("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("visitors")
    .update(req.body)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/visitors/:id/convert — convert visitor to student
router.post("/:id/convert", async (req, res) => {
  const { data: visitor, error: vErr } = await supabase
    .from("visitors")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (vErr) return res.status(404).json({ error: "Visitor পাওয়া যায়নি" });

  const { data: student, error: sErr } = await supabase
    .from("students")
    .insert(encryptSensitiveFields({
      name_en: visitor.name_en,
      name_bn: visitor.name_bn,
      phone: visitor.phone,
      email: visitor.email,
      source: visitor.source,
      branch: visitor.branch,
      status: "ENROLLED",
      ...req.body,
    }))
    .select()
    .single();

  if (sErr) return res.status(400).json({ error: sErr.message });

  await supabase.from("visitors").update({ status: "converted", converted_student_id: student.id }).eq("id", req.params.id);

  res.status(201).json(student);
});

module.exports = router;
