/**
 * audit-search.js — Activity log search + CSV export (Phase 6 F17)
 *
 * Mounted at /api/audit-search
 *
 * Routes:
 *   GET /  — paginated search across activity_log with filters
 *           query: action, module, user_id, from, to, q (free text), page, limit
 *   GET /export.csv — same filters, returns CSV
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

function buildWhere(req) {
  const where = ["a.agency_id = $1"];
  const params = [req.user.agency_id];
  if (req.query.action) { where.push(`a.action = $${params.length + 1}`); params.push(req.query.action); }
  if (req.query.module) { where.push(`a.module = $${params.length + 1}`); params.push(req.query.module); }
  if (req.query.user_id) { where.push(`a.user_id = $${params.length + 1}`); params.push(req.query.user_id); }
  if (req.query.from) { where.push(`a.created_at >= $${params.length + 1}`); params.push(req.query.from); }
  if (req.query.to) { where.push(`a.created_at <= $${params.length + 1}`); params.push(req.query.to + " 23:59:59"); }
  if (req.query.q) {
    where.push(`(a.description ILIKE $${params.length + 1} OR a.module ILIKE $${params.length + 1})`);
    params.push(`%${req.query.q}%`);
  }
  return { where: where.join(" AND "), params };
}

router.get("/", requireOwner, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const offset = (page - 1) * limit;

  const { where, params } = buildWhere(req);
  params.push(limit); params.push(offset);

  const { rows: items } = await supabase.pool.query(`
    SELECT a.*, u.name AS user_name, u.email AS user_email
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where}
    ORDER BY a.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  // Count for pagination header
  const countParams = params.slice(0, params.length - 2);
  const { rows: countRows } = await supabase.pool.query(
    `SELECT COUNT(*)::int AS total FROM activity_log a WHERE ${where}`,
    countParams
  );

  res.json({ page, limit, total: countRows[0]?.total || 0, items });
}));

router.get("/export.csv", requireOwner, asyncHandler(async (req, res) => {
  const { where, params } = buildWhere(req);
  const { rows } = await supabase.pool.query(`
    SELECT a.created_at, a.action, a.module, a.record_id, a.description, a.ip_address,
           u.name AS user_name, u.email AS user_email
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${where}
    ORDER BY a.created_at DESC LIMIT 10000
  `, params);

  // Build CSV with BOM
  const header = ["Time", "User", "Email", "Action", "Module", "Record ID", "Description", "IP"].join(",");
  const csvRows = rows.map(r => [
    r.created_at,
    `"${(r.user_name || "").replace(/"/g, '""')}"`,
    r.user_email || "",
    r.action || "",
    r.module || "",
    r.record_id || "",
    `"${(r.description || "").replace(/"/g, '""').slice(0, 500)}"`,
    r.ip_address || "",
  ].join(","));
  const csv = String.fromCharCode(0xFEFF) + header + "\n" + csvRows.join("\n");

  const filename = `audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}));

module.exports = router;
