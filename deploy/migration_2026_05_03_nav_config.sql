-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_03_nav_config.sql — per-agency sidebar configuration.
--
-- Each agency owner decides which sidebar nav items are visible for their
-- staff. Stored as a TEXT[] of nav-key strings to HIDE (default empty
-- array = everything visible). Server enforces too via agencyNavGuard
-- middleware so URL-typing doesn't bypass the hide.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE agency_settings
  ADD COLUMN IF NOT EXISTS disabled_nav_items TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS idx_agency_settings_nav_disabled
  ON agency_settings USING gin (disabled_nav_items);
