/**
 * template.js — Interview template upload + mapping routes
 *
 * POST   /:id/interview-template      — Excel template upload + header/label detect
 * DELETE /:id/interview-template      — template delete
 * POST   /:id/interview-mapping       — placeholder → field mapping save
 * GET    /:id/interview-mapping       — mapping read
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");
const { checkPermission } = require("../../middleware/checkPermission");
const cache = require("../../lib/cache");
const { dbError } = require("../../lib/dbError");
const { uploadDir, templateUpload } = require("./_shared");

const router = express.Router();
router.use(auth);

// POST /api/schools/:id/interview-template — টেমপ্লেট আপলোড
router.post("/:id/interview-template", checkPermission("schools", "write"), templateUpload.single("template"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ফাইল দিন" });
  const ExcelJS = require("exceljs");
  // Original filename sanitize করে রাখি (school_id prefix দিয়ে unique)
  const origName = (req.file.originalname || "template.xlsx").replace(/[^a-zA-Z0-9._\-\u0980-\u09FF]/g, "_");
  const safeName = `${req.params.id}_${origName}`;
  const finalPath = path.join(uploadDir, safeName);
  fs.renameSync(req.file.path, finalPath);

  // Template থেকে headers/labels পড়ি — mapping UI-র জন্য
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(finalPath);
  const ws = wb.worksheets[0];
  const headers = []; // [{position, label}]

  // Auto-detect: row-wise (header row) বা column-wise (label column)
  // Row-wise: সবচেয়ে বেশি non-empty cell সহ row = header row
  let bestRow = 1, bestCount = 0;
  for (let r = 1; r <= Math.min(ws.rowCount || 10, 10); r++) {
    let count = 0;
    ws.getRow(r).eachCell({ includeEmpty: false }, () => count++);
    if (count > bestCount) { bestCount = count; bestRow = r; }
  }
  // Extract header labels
  ws.getRow(bestRow).eachCell({ includeEmpty: false }, (cell, colNum) => {
    let val = "";
    if (cell.value && typeof cell.value === "object" && cell.value.richText) {
      val = cell.value.richText.map(r => r.text || "").join("");
    } else { val = String(cell.value || ""); }
    val = val.replace(/\n/g, " ").trim();
    if (val) headers.push({ position: colNum, label: val, field: "" });
  });

  // Column-wise labels (A column) — যদি header row-এ কম cell থাকে
  const colLabels = [];
  for (let r = 1; r <= Math.min(ws.rowCount || 30, 30); r++) {
    const cell = ws.getCell(r, 1);
    let val = "";
    if (cell.value && typeof cell.value === "object" && cell.value.richText) {
      val = cell.value.richText.map(r => r.text || "").join("");
    } else { val = String(cell.value || ""); }
    val = val.replace(/\n/g, " ").trim();
    if (val) colLabels.push({ position: r, label: val, field: "" });
  }

  // DB-তে সেভ
  const { data, error } = await supabase.from("schools")
    .update({ interview_template: safeName, interview_template_name: origName, interview_template_mapping: null })
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.uploadTemplate");

  // Cache invalidate — টেমপ্লেট আপলোড হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({
    template: safeName, template_name: origName,
    header_row: bestRow, row_headers: headers, col_labels: colLabels,
    message: "টেমপ্লেট আপলোড হয়েছে — এখন ম্যাপিং করুন"
  });
}));

// DELETE /api/schools/:id/interview-template — টেমপ্লেট মুছুন
router.delete("/:id/interview-template", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { data: school } = await supabase.from("schools").select("interview_template").eq("id", req.params.id).single();
  if (school?.interview_template) {
    const p = path.join(uploadDir, school.interview_template);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  await supabase.from("schools").update({ interview_template: null, interview_template_name: null, interview_template_mapping: null })
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id);

  // Cache invalidate — টেমপ্লেট মুছে ফেলা হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({ success: true });
}));

// POST /api/schools/:id/interview-mapping — ম্যাপিং সেভ
router.post("/:id/interview-mapping", checkPermission("schools", "write"), asyncHandler(async (req, res) => {
  const { mapping, format, header_row } = req.body;
  // mapping = [{position: 1, label: "No.", field: "no"}, ...]
  const { data, error } = await supabase.from("schools")
    .update({ interview_template_mapping: JSON.stringify({ format: format || "row", header_row: header_row || 3, mapping }) })
    .eq("id", req.params.id).eq("agency_id", req.user.agency_id).select().single();
  if (error) return dbError(res, error, "schools.saveMapping");

  // Cache invalidate — ম্যাপিং সেভ হলে cache মুছে দাও
  cache.invalidate(req.user.agency_id);

  res.json({ success: true, message: "ম্যাপিং সেভ হয়েছে" });
}));

// GET /api/schools/:id/interview-mapping — ম্যাপিং পড়ুন
router.get("/:id/interview-mapping", checkPermission("schools", "read"), asyncHandler(async (req, res) => {
  const { data } = await supabase.from("schools")
    .select("interview_template, interview_template_name, interview_template_mapping")
    .eq("id", req.params.id).single();
  let parsed = null;
  try { parsed = JSON.parse(data?.interview_template_mapping || "null"); } catch {}
  res.json({ template: data?.interview_template, template_name: data?.interview_template_name, mapping: parsed });
}));

module.exports = router;
