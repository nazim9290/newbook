# Soft Delete Rollout

Adds enterprise-grade soft delete to the 21 core multi-tenant tables. GDPR-compliant retention window + audit trail preservation.

## 1. Apply the migration

```bash
psql $DATABASE_URL -f deploy/migration_soft_delete.sql
```

Or via the local SSH tunnel (project convention):

```bash
psql "postgresql://agencybook@localhost:5432/agencybook" -f deploy/migration_soft_delete.sql
```

The migration is idempotent (DO block + IF NOT EXISTS) — safe to re-run. It only adds a nullable `deleted_at TIMESTAMPTZ` column and a partial index per table; nothing is altered or dropped.

Tables touched (21):
`visitors, students, agents, schools, partners, employees, communications, documents, payments, batches, branches, holidays, tasks, alumni, inventory, broadcasts, feedback, calendar_events, leaves, attendance, accounts`

## 2. Roll out per-route

`src/routes/visitors.js` is the canonical template. To migrate each remaining route, repeat these four edits:

1. **Import the helper** at the top of the file:

   ```js
   const { applyActiveFilter, softDeleteRow, restoreRow } = require("../lib/softDelete");
   ```

2. **GET list** — chain `applyActiveFilter(query)` after the `agency_id` filter so soft-deleted rows never appear:

   ```js
   let query = supabase.from("X").select("*", { count: "exact" }).eq("agency_id", req.user.agency_id);
   query = applyActiveFilter(query);
   ```

3. **GET / lookup by id** — add `.is("deleted_at", null)` so a deleted row reads as 404.

4. **DELETE handler** — replace `supabase.from("X").delete()...` with:

   ```js
   const { data, error } = await softDeleteRow({
     table: "X", id: req.params.id,
     agencyId: req.user.agency_id, userId: req.user.id, supabase,
   });
   if (error) return res.status(400).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
   if (!data) return res.status(404).json({ error: "রেকর্ড পাওয়া যায়নি" });
   ```

5. **Add restore + trash routes** (gated by the existing `delete` permission):

   ```js
   router.post("/:id/restore", checkPermission("X", "delete"), asyncHandler(async (req, res) => { ... }));
   router.get("/trash",        checkPermission("X", "delete"), asyncHandler(async (req, res) => { ... }));
   ```

   Use the visitors.js implementation as a copy-paste seed.

Rollout order suggestion (highest-risk-of-loss first): `students → payments → documents → schools → batches → employees → agents → partners → tasks → calendar_events → communications → alumni → branches → holidays → leaves → attendance → accounts → inventory → broadcasts → feedback`.

## 3. Retention policy + cleanup job

- **Retention window**: 90 days (configurable per call to `purgeExpired`).
- **Purge function**: `src/lib/softDelete.js::purgeExpired({ table, retentionDays, supabase })`.
- **Status**: TODO — not yet wired to a scheduler. Suggested wiring:
  - Add a daily cron via PM2 `cron_restart` or a lightweight `node-cron` worker (no new npm dep needed if you use `setInterval` in a separate `scripts/purgeSoftDeleted.js`).
  - Iterate every soft-delete-aware table and log the count purged to `activity_log` under `module: "system"`, `action: "purge"`.
  - Suggested schedule: 03:30 Asia/Dhaka, after the nightly DB backup.

Until the scheduler ships, soft-deleted rows accumulate harmlessly. The partial indexes mean active-row queries are unaffected by trash size.

## 4. Backward compatibility

The migration is non-breaking:

- Routes not yet migrated continue to issue physical `DELETE` — that still works because `deleted_at` is nullable and unused.
- Migrated routes write `deleted_at` and ignore the unmigrated ones.
- Activity log + cache invalidation contracts are unchanged; only the action's effect on the row differs.

This means you can ship the migration today and roll out routes one at a time with zero coordination.

## 5. Frontend hooks (TODO, not in this rollout)

When the frontend exposes "Trash" UI, use:

- `GET /api/<module>/trash` — paginated list (limit/offset).
- `POST /api/<module>/:id/restore` — undo a soft delete.

Keep these gated on the same `delete` permission so visibility rules don't accidentally widen.
