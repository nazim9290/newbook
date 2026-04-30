/**
 * schools/templates.js — list templates linked to a school.
 *
 * GET /api/schools/:id/templates
 *   → all default_templates linked to this school via default_template_schools,
 *     PLUS global templates (no school link). Useful for SchoolDetailView's Documents tab.
 *
 * Query params:
 *   tag=resume                   filter by tag (single)
 *   include_global=0|1           include global (no school link) templates (default 1)
 *
 * Response shape (per row): { id, name, name_bn, category, sub_category, country, tags,
 *                             file_name, file_url, scope: "school" | "global", template_data }
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
  if (allIds.length === 0) return res.json([]);

  // 3. Fetch template rows + filter by tag if provided
  let q = supabase.from("default_templates")
    .select("id, name, name_bn, description, category, sub_category, country, tags, file_url, file_name, template_data, sort_order")
    .in("id", allIds)
    .eq("is_active", true)
    .order("sort_order");
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "Template লোড ব্যর্থ" });

  let list = (data || []).map(t => ({
    ...t,
    tags: t.tags || [],
    scope: linkedIds.has(t.id) ? "school" : "global",
  }));

  if (tagFilter) {
    list = list.filter(t => Array.isArray(t.tags) && t.tags.includes(tagFilter));
  }

  res.json(list);
}));

module.exports = router;
