/**
 * alerts.js — Owner-facing alerts dashboard endpoints
 *
 * Mounted at /api/alerts
 *
 * Routes:
 *   GET  /expiring         — list upcoming document expiries
 *   GET  /sent             — paginated alerts that have been dispatched
 *   POST /scan-now         — manual trigger (super_admin/owner)
 */

const express = require("express");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const expiryScanner = require("../lib/expiryScanner");

const router = express.Router();
router.use(auth);

const OWNER_ROLES = new Set(["super_admin", "owner", "admin", "branch_manager"]);
function requireOwner(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!OWNER_ROLES.has(role)) return res.status(403).json({ error: "অনুমতি নেই" });
  next();
}

// GET /expiring?within=90 — upcoming expiries
router.get("/expiring", asyncHandler(async (req, res) => {
  const within = Math.min(365, Math.max(1, parseInt(req.query.within || "90", 10)));
  const items = await expiryScanner.listUpcoming(req.user.agency_id, within);
  res.json({ within_days: within, count: items.length, items });
}));

// GET /sent — past alerts
router.get("/sent", requireOwner, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
  const offset = (page - 1) * limit;

  const { rows: items } = await supabase.pool.query(`
    SELECT a.*, s.name_en, s.name_bn
    FROM expiry_alerts_sent a
    LEFT JOIN students s ON s.id = a.student_id
    WHERE a.agency_id = $1
    ORDER BY a.created_at DESC
    LIMIT $2 OFFSET $3
  `, [req.user.agency_id, limit, offset]);

  res.json({ page, limit, items });
}));

// POST /scan-now — manual trigger (owner can scan their own agency now)
router.post("/scan-now", requireOwner, asyncHandler(async (req, res) => {
  try {
    const { rows: agencyRows } = await supabase.pool.query(
      `SELECT id, name FROM agencies WHERE id = $1`, [req.user.agency_id]
    );
    if (!agencyRows.length) return res.status(404).json({ error: "Agency পাওয়া যায়নি" });
    const result = await expiryScanner.scanAgency(agencyRows[0]);
    res.json(result);
  } catch (err) {
    console.error("[alerts/scan-now]", err.message);
    res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
