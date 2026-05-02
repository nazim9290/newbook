-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_02_schema_migrations.sql — migration tracking table.
--
-- Until now migrations were applied ad-hoc per session — easy to:
--   * forget to apply a migration on dev or prod
--   * accidentally re-apply (mostly safe due to IF NOT EXISTS, but not all)
--   * lose track of WHICH migrations are in WHICH environment
--
-- This table records every migration filename + checksum + applied-at.
-- The runner script (scripts/migrate.js) skips already-applied files.
--
-- Idempotent. Existing migrations should be backfilled into this table
-- after first apply (the runner does that automatically the first time).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename     TEXT PRIMARY KEY,
  checksum     TEXT,                              -- SHA256 of file contents at apply time
  applied_at   TIMESTAMPTZ DEFAULT now(),
  applied_by   TEXT                               -- 'manual' | 'cron' | actual user
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agencybook') THEN
    EXECUTE 'GRANT ALL ON TABLE schema_migrations TO agencybook';
  END IF;
END $$;
