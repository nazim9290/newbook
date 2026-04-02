/**
 * docdata.js — Document Type ও Student Document Data API
 *
 * doc_types: Admin-defined document types with custom fields
 * document_data: Student-wise document field data
 */

const express = require("express");
const supabase = require("../lib/supabase");
const auth = require("../middleware/auth");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);

// ════════════════ DOC TYPES ════════════════

// GET /api/docdata/types — সক্রিয় document types (frontend Documents, DocGen ইত্যাদির জন্য)
router.get("/types", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("doc_types")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .eq("is_active", true)
    .order("sort_order");
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data || []);
}));

// GET /api/docdata/types/all — সব document type (active + inactive) — Admin Settings-এর জন্য
router.get("/types/all", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("doc_types")
    .select("*")
    .eq("agency_id", req.user.agency_id)
    .order("sort_order");
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data || []);
}));

// POST /api/docdata/types — নতুন document type তৈরি (Admin)
router.post("/types", asyncHandler(async (req, res) => {
  const record = {
    ...req.body,
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
  };
  const { data, error } = await supabase.from("doc_types").insert(record).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.status(201).json(data);
}));

// PATCH /api/docdata/types/:id — document type update
router.patch("/types/:id", asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from("doc_types").update(req.body).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// DELETE /api/docdata/types/:id
router.delete("/types/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("doc_types").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ success: true });
}));

// ════════════════ DOCUMENT DATA (Student-wise) ════════════════

// GET /api/docdata/student/:studentId — একটি student-এর সব document data
router.get("/student/:studentId", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("document_data")
    .select("*, doc_types(name, name_bn, category, fields)")
    .eq("agency_id", req.user.agency_id)
    .eq("student_id", req.params.studentId)
    .order("created_at");
  if (error) return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  res.json(data || []);
}));

// GET /api/docdata/student/:studentId/:docTypeId — নির্দিষ্ট document-এর data
router.get("/student/:studentId/:docTypeId", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("document_data")
    .select("*, doc_types(name, name_bn, fields)")
    .eq("agency_id", req.user.agency_id)
    .eq("student_id", req.params.studentId)
    .eq("doc_type_id", req.params.docTypeId)
    .single();
  if (error) return res.json({ field_data: {} }); // না থাকলে empty
  res.json(data);
}));

// POST /api/docdata/save — document data save/update (upsert)
router.post("/save", asyncHandler(async (req, res) => {
  const { student_id, doc_type_id, field_data, notes } = req.body;
  if (!student_id || !doc_type_id) return res.status(400).json({ error: "student_id ও doc_type_id দিন" });

  const record = {
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
    student_id,
    doc_type_id,
    field_data: typeof field_data === "string" ? field_data : JSON.stringify(field_data || {}),
    status: "completed",
  };

  // notes column থাকলে record-এ যোগ করো (DB migration পরে কাজ করবে)
  if (notes !== undefined && notes !== null) {
    record.notes = notes;
  }

  // Upsert: student_id + doc_type_id unique
  const { data, error } = await supabase
    .from("document_data")
    .upsert(record, { onConflict: "student_id,doc_type_id" })
    .select("*, doc_types(name, name_bn)")
    .single();

  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json(data);
}));

// DELETE /api/docdata/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("document_data").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ success: true });
}));

module.exports = router;
