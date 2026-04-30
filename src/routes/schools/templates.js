/**
 * schools/templates.js — list templates linked to a school.
 *
 * GET /api/schools/:id/templates
 *   Returns BOTH:
 *     - default_templates linked via default_template_schools (super-admin catalog)
 *       + global default_templates (no school link)
 *     - agency's own excel_templates linked via excel_template_schools (or legacy school_id)
 *
 * Query params:
 *   tag=resume                   filter by tag (single)
 *   include_global=0|1           include global (no school link) default templates (default 1)
 *
 * Response shape (per row):
 *   default_templates row → { ..., source: "default", scope: "school"|"global" }
 *   excel_templates row    → { id, name (=school_name + file), category: "excel",
 *                               tags, file_name, file_url, source: "agency", scope: "school" }
 */

const express = require("express");
const router = express.Router();
const supabase = require("../../lib/db");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../lib/asyncHandler");

router.use(auth);

router.get("/:id/templates", asyncHandler(async (req, res) => {
  const { id: schoolId } = req.params;
  const tagFilter = (req.query.tag || "").toString().trim();
  const includeGlobal = req.query.include_global !== "0";

  // 1. Linked template ids via junction
  const pool = supabase.pool;
  const { rows: linkRows } = await pool.query(
    `SELECT template_id FROM default_template_schools WHERE school_id = $1`,
    [schoolId]
  );
  const linkedIds = new Set(linkRows.map(r => r.template_id));

  // 2. Global templates: rows with NO entries in default_template_schools at all
  let globalIds = new Set();
  if (includeGlobal) {
    const { rows: globalRows } = await pool.query(`
      SELECT t.id FROM default_templates t
      WHERE t.is_active = true
        AND NOT EXISTS (SELECT 1 FROM default_template_schools dts WHERE dts.template_id = t.id)
    `);
    globalIds = new Set(globalRows.map(r => r.id));
  }

  const allIds = [...new Set([...linkedIds, ...globalIds])];

  // 3. Fetch default-template rows
  let list = [];
  if (allIds.length > 0) {
    const { data, error } = await supabase.from("default_templates")
      .select("id, name, name_bn, description, category, sub_category, country, tags, file_url, file_name, template_data, sort_order")
      .in("id", allIds)
      .eq("is_active", true)
      .order("sort_order");
    if (error) return res.status(500).json({ error: "Template লোড ব্যর্থ" });
    list = (data || []).map(t => ({
      ...t,
      tags: t.tags || [],
      source: "default",
      scope: linkedIds.has(t.id) ? "school" : "global",
    }));
  }

  // 4. Agency's own excel_templates linked to this school (via junction OR legacy school_id)
  try {
    const { rows: agencyRows } = await pool.query(`
      SELECT et.id, et.school_name, et.file_name, et.template_url, et.tags,
             et.total_fields, et.mapped_fields, et.created_at
        FROM excel_templates et
       WHERE et.agency_id = $1
         AND (
           et.school_id = $2
           OR EXISTS (
             SELECT 1 FROM excel_template_schools ets
              WHERE ets.template_id = et.id AND ets.school_id = $2
           )
         )
    `, [req.user.agency_id, schoolId]);

    for (const e of agencyRows) {
      const fileBaseUrl = (e.template_url || "").startsWith("/")
        ? e.template_url
        : `/uploads/excel-templates/${(e.template_url || "").split(/[\\\\/]/).pop()}`;
      list.push({
        id: e.id,
        name: `${e.school_name || ""} — ${e.file_name || ""}`.trim().replace(/^—\s*/, ""),
        name_bn: null,
        category: "excel",
        sub_category: "resume",
        country: null,
        tags: e.tags || [],
        file_name: e.file_name,
        file_url: fileBaseUrl,
        source: "agency",
        scope: "school",
        total_fields: e.total_fields,
        mapped_fields: e.mapped_fields,
      });
    }
  } catch (err) {
    console.error("[schools/templates] agency excel fetch:", err.message);
  }

  if (tagFilter) {
    list = list.filter(t => Array.isArray(t.tags) && t.tags.includes(tagFilter));
  }

  res.json(list);
}));

module.exports = router;
