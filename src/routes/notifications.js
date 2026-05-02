/**
 * notifications.js — Per-user in-app inbox.
 *
 * Reads from notifications_sent where user_id = req.user.id (so each user
 * sees only their own; agency admins still see only their personal feed
 * — no cross-user peek by design).
 *
 * Channels surfaced: all of them (email, push, telegram, sms, whatsapp,
 * plus future channels). Even if the actual delivery is via email/push,
 * the inbox shows a unified thread per user.
 *
 * Endpoints:
 *   GET   /api/notifications              — paginated feed (?page, ?pageSize, ?unread_only)
 *   GET   /api/notifications/unread-count — { count } for the bell badge
 *   PATCH /api/notifications/:id/read     — mark one read
 *   PATCH /api/notifications/read-all     — mark all read for this user
 *   DELETE /api/notifications/:id         — hide from inbox (sets read + a flag-ish)
 */

const express = require("express");
const supabase = require("../lib/db");
const auth = require("../middleware/auth");
const tenancy = require("../middleware/tenancy");
const asyncHandler = require("../lib/asyncHandler");

const router = express.Router();
router.use(auth);
router.use(tenancy);

// ── GET /api/notifications — paginated user feed ─────────────────────
router.get("/", asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const unreadOnly = req.query.unread_only === "1";

  const filters = ["agency_id = $1", "user_id = $2", "status <> 'hidden'"];
  const params = [req.user.agency_id, req.user.id];
  if (unreadOnly) filters.push("read_at IS NULL");
  const where = "WHERE " + filters.join(" AND ");

  const totalRes = await supabase.pool.query(
    `SELECT count(*)::int AS n FROM notifications_sent ${where}`,
    params
  );
  const total = totalRes.rows[0]?.n ?? 0;

  const itemsRes = await supabase.pool.query(`
    SELECT id, channel, template, subject, data, status,
           sent_at, created_at, read_at
      FROM notifications_sent
      ${where}
     ORDER BY created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}
  `, params);

  res.json({ items: itemsRes.rows, total, page, pageSize });
}));

// ── GET /api/notifications/unread-count — bell badge ─────────────────
router.get("/unread-count", asyncHandler(async (req, res) => {
  const r = await supabase.pool.query(
    `SELECT count(*)::int AS n
       FROM notifications_sent
      WHERE agency_id = $1 AND user_id = $2 AND read_at IS NULL AND status <> 'hidden'`,
    [req.user.agency_id, req.user.id]
  );
  res.json({ count: r.rows[0]?.n ?? 0 });
}));

// ── PATCH /api/notifications/read-all ────────────────────────────────
router.patch("/read-all", asyncHandler(async (req, res) => {
  const r = await supabase.pool.query(
    `UPDATE notifications_sent
        SET read_at = now()
      WHERE agency_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [req.user.agency_id, req.user.id]
  );
  res.json({ marked_read: r.rowCount });
}));

// ── PATCH /api/notifications/:id/read ────────────────────────────────
router.patch("/:id/read", asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const r = await supabase.pool.query(
    `UPDATE notifications_sent
        SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND agency_id = $2 AND user_id = $3
      RETURNING id, read_at`,
    [id, req.user.agency_id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Notification পাওয়া যায়নি" });
  res.json(r.rows[0]);
}));

// ── DELETE /api/notifications/:id — hide from inbox ──────────────────
// Soft-hide: marks read + drops from feed via a 'hidden' status sentinel.
// We don't actually DELETE — keeps audit trail intact for compliance.
router.delete("/:id", asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  const r = await supabase.pool.query(
    `UPDATE notifications_sent
        SET read_at = COALESCE(read_at, now()),
            status = CASE WHEN status IN ('hidden') THEN status ELSE 'hidden' END
      WHERE id = $1 AND agency_id = $2 AND user_id = $3
      RETURNING id`,
    [id, req.user.agency_id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Notification পাওয়া যায়নি" });
  res.json({ ok: true });
}));

module.exports = router;
