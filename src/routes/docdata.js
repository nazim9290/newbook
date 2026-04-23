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
const { getBranchFilter } = require("../lib/branchFilter");
const { logActivity } = require("../lib/activityLog");

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
  // ── Optimistic Lock — concurrent edit protection ──
  const clientUpdatedAt = req.body.updated_at;
  if (clientUpdatedAt) {
    const { data: current } = await supabase.from("doc_types").select("updated_at").eq("id", req.params.id).single();
    if (current && current.updated_at && new Date(current.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: "এই ডাটা অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন", code: "CONFLICT" });
    }
  }

  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from("doc_types").update(updates).eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
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

// ── GET /api/docdata/checklist-summary — সব student × সব doc-type completion summary ──
// Returns: { students: [...], docTypes: [...], summary: { [student_id]: { [doc_type_id]: { filled, total, pct } } } }
// Used by: Documents Checklist matrix view (print-friendly)
router.get("/checklist-summary", asyncHandler(async (req, res) => {
  const agencyId = req.user.agency_id;
  const branchFilter = getBranchFilter(req.user);

  // Students — branch filtered; batch + intake include for frontend filters
  let studentsQ = supabase.from("students").select("id, name_en, batch, intake, status, branch").eq("agency_id", agencyId);
  if (branchFilter) studentsQ = studentsQ.eq("branch", branchFilter);
  const { data: students } = await studentsQ;

  // Active doc types
  const { data: docTypes } = await supabase.from("doc_types")
    .select("id, name, name_bn, category, fields").eq("agency_id", agencyId).eq("is_active", true).order("category");

  // All document_data for agency — field_data + received flag
  const { data: allData } = await supabase.from("document_data")
    .select("student_id, doc_type_id, field_data, received").eq("agency_id", agencyId);

  // Summary build — student_id → doc_type_id → { filled, total, pct, received }
  const summary = {};
  (students || []).forEach(s => { summary[s.id] = {}; });
  (allData || []).forEach(row => {
    const dt = (docTypes || []).find(d => d.id === row.doc_type_id);
    if (!dt || !summary[row.student_id]) return;
    const fields = dt.fields || [];
    const fieldData = row.field_data || {};
    const filled = fields.filter(f => {
      const v = fieldData[f.key];
      return v !== undefined && v !== null && String(v).trim() !== "";
    }).length;
    summary[row.student_id][row.doc_type_id] = {
      filled, total: fields.length,
      pct: fields.length > 0 ? Math.round((filled / fields.length) * 100) : 0,
      received: !!row.received,
    };
  });

  res.json({ students: students || [], docTypes: docTypes || [], summary });
}));

// GET /api/docdata/student/:studentId — একটি student-এর সব document data
router.get("/student/:studentId", asyncHandler(async (req, res) => {
  // Branch filter — staff শুধু নিজ branch-এর student-এর data দেখবে
  const branchFilter = getBranchFilter(req.user);
  if (branchFilter) {
    const { data: student } = await supabase.from("students")
      .select("branch")
      .eq("id", req.params.studentId)
      .eq("agency_id", req.user.agency_id)
      .single();
    if (student && student.branch && student.branch !== branchFilter) {
      return res.status(403).json({ error: "এই student আপনার branch-এ নেই" });
    }
  }

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

// ── POST /api/docdata/mark-received — শুধু received flag toggle (simple mode) ──
// Agency যারা ডকুমেন্টের ফিল্ড ইনপুট করতে চায় না, শুধু 'জমা পেয়েছে' checkbox
router.post("/mark-received", asyncHandler(async (req, res) => {
  const { student_id, doc_type_id, received } = req.body;
  if (!student_id || !doc_type_id) return res.status(400).json({ error: "student_id ও doc_type_id দিন" });

  const now = new Date().toISOString();
  const record = {
    agency_id: req.user.agency_id,
    student_id,
    doc_type_id,
    received: !!received,
    received_at: received ? now : null,
    updated_at: now,
  };

  // Upsert: existing row থাকলে field_data preserve হবে, শুধু received toggle
  const { data, error } = await supabase
    .from("document_data")
    .upsert(record, { onConflict: "student_id,doc_type_id" })
    .select()
    .single();
  if (error) { console.error("[DB]", error.message); return res.status(500).json({ error: "সার্ভার ত্রুটি" }); }
  res.json(data);
}));

// POST /api/docdata/save — document data save/update (upsert)
router.post("/save", asyncHandler(async (req, res) => {
  const { student_id, doc_type_id, field_data, notes, received, updated_at: clientUpdatedAt } = req.body;
  if (!student_id || !doc_type_id) return res.status(400).json({ error: "student_id ও doc_type_id দিন" });

  // ── Optimistic Lock — concurrent edit protection ──
  // Frontend updated_at পাঠালে check করো — অন্য কেউ এর মধ্যে পরিবর্তন করেছে কিনা
  if (clientUpdatedAt) {
    const { data: existing } = await supabase.from("document_data")
      .select("updated_at")
      .eq("student_id", student_id)
      .eq("doc_type_id", doc_type_id)
      .single();
    if (existing && existing.updated_at && new Date(existing.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({
        error: "এই ডকুমেন্ট অন্য কেউ পরিবর্তন করেছে — রিফ্রেশ করুন",
        code: "CONFLICT",
        server_updated_at: existing.updated_at,
      });
    }
  }

  const now = new Date().toISOString();
  const record = {
    agency_id: req.user.agency_id || "a0000000-0000-0000-0000-000000000001",
    student_id,
    doc_type_id,
    field_data: typeof field_data === "string" ? field_data : JSON.stringify(field_data || {}),
    status: "completed",
    updated_at: now,
  };
  // received flag — explicit পাঠালে respect; না পাঠালে যদি কোনো field filled থাকে → auto-mark received
  if (received !== undefined) {
    record.received = !!received;
    record.received_at = received ? now : null;
  } else if (field_data && typeof field_data === "object" && Object.values(field_data).some(v => v !== null && v !== undefined && String(v).trim() !== "")) {
    record.received = true;
    record.received_at = now;
  }

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

  // ── Activity Log — কে কখন কোন document আপডেট করেছে ──
  const docName = data?.doc_types?.name || doc_type_id;
  logActivity({
    agencyId: req.user.agency_id, userId: req.user.id, action: "update", module: "documents",
    recordId: data?.id || student_id,
    description: `ডকুমেন্ট আপডেট: ${docName} — ${student_id} (by ${req.user.name || req.user.email || "Staff"})`,
    ip: req.ip,
  }).catch(() => {});

  res.json(data);
}));

// DELETE /api/docdata/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  const { error } = await supabase.from("document_data").delete().eq("id", req.params.id).eq("agency_id", req.user.agency_id);
  if (error) { console.error("[DB]", error.message); return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" }); }
  res.json({ success: true });
}));

module.exports = router;
