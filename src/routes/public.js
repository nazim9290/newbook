/**
 * public.js — Unauthenticated public endpoints.
 *
 *   GET  /api/public/agency/:slug         — Returns minimal public branding (name, logo, theme)
 *                                            so the visitor form can render with the agency look.
 *   POST /api/public/agency/:slug/visitor — Submit a visitor record under that agency. No login.
 *
 * Why no JWT? These power the public visitor-capture URL (e.g. /v/<slug>) that an agency
 * owner hands to a walk-in visitor on a tablet. The visitor must be able to submit without
 * any agency staff being logged in on that device.
 *
 * Anti-abuse: rate-limited at the app-level (express-rate-limit). Records validated against
 * a strict whitelist; agency lookup is by `subdomain` (not arbitrary id) so URLs are predictable.
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const { encryptSensitiveFields } = require("../lib/crypto");
const { generateId } = require("../lib/idGenerator");
const { logActivity } = require("../lib/activityLog");

const router = express.Router();
// NOTE: this router is mounted in app.js BEFORE the /api/auth requirement, so no auth middleware.

// ── GET /api/public/agency/:slug ────────────────────────────
// Returns minimal public-safe agency info for rendering the visitor form header.
router.get("/agency/:slug", asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("agencies")
    .select("id, name, name_bn, subdomain, logo_url, status")
    .eq("subdomain", req.params.slug)
    .single();
  if (error || !data) return res.status(404).json({ error: "Agency পাওয়া যায়নি" });
  if (data.status && data.status !== "active") return res.status(403).json({ error: "Agency বর্তমানে inactive" });

  res.json({
    id: data.id,
    name: data.name,
    name_bn: data.name_bn,
    subdomain: data.subdomain,
    logo_url: data.logo_url,
  });
}));

// ── POST /api/public/agency/:slug/visitor ────────────────────
// Anonymous visitor submission. Strict whitelist; agency_id comes from URL slug, never body.
router.post("/agency/:slug/visitor", asyncHandler(async (req, res) => {
  const body = req.body || {};

  // Look up agency by slug
  const { data: agency } = await supabase
    .from("agencies").select("id, status").eq("subdomain", req.params.slug).single();
  if (!agency) return res.status(404).json({ error: "Agency পাওয়া যায়নি" });
  if (agency.status && agency.status !== "active") return res.status(403).json({ error: "Agency বর্তমানে inactive" });

  // Required minimum
  const name = (body.name || body.name_en || "").trim();
  const phone = (body.phone || "").trim();
  if (!name)  return res.status(400).json({ error: "নাম দিন" });
  if (!phone) return res.status(400).json({ error: "ফোন নম্বর দিন" });

  const displayId = await generateId(agency.id, "visitor");
  const record = {
    agency_id: agency.id,
    display_id: displayId,
    name,
    name_bn: (body.name_bn || "").trim() || name,
    phone,
    email: (body.email || "").trim() || null,
    dob: body.dob || null,
    gender: body.gender || null,
    address: (body.address || "").trim() || null,
    education: body.education ? JSON.stringify(body.education) : "[]",
    has_jp_cert: !!body.has_jp_cert,
    jp_exam_type: body.jp_exam_type || null,
    jp_level: body.jp_level || null,
    jp_score: body.jp_score || null,
    visa_type: body.visa_type || null,
    interested_countries: Array.isArray(body.interested_countries) && body.interested_countries.length > 0
      ? `{${body.interested_countries.join(",")}}` : "{Japan}",
    interested_intake: body.interested_intake || null,
    budget_concern: !!body.budget_concern,
    source: "Public Form",                          // marker — easy to filter on agency side
    notes: (body.notes || "").trim() || null,
    visit_date: new Date().toISOString().slice(0, 10),
    status: "Interested",
  };

  const { data, error } = await supabase
    .from("visitors").insert(encryptSensitiveFields(record)).select("id, display_id, name").single();
  if (error) {
    console.error("[Public Visitor]", error.message);
    return res.status(500).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
  }

  // Log without PII
  logActivity({
    agencyId: agency.id, userId: null,
    action: "create", module: "visitors", recordId: data.id,
    description: `Public form-এ নতুন visitor`, ip: req.ip,
  }).catch(() => {});

  res.json({ ok: true, display_id: data.display_id, name: data.name });
}));

module.exports = router;
