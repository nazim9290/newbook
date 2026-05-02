-- ═══════════════════════════════════════════════════════════════════════
-- Subscription Metadata + Trial Reminder Tracking — Phase 4A.6
-- ───────────────────────────────────────────────────────────────────────
-- agency_subscriptions.metadata — JSONB grab-bag for non-critical state
-- (last_trial_reminder_day, last_migration_reminder_at, etc.)
--
-- agency_subscriptions.last_trial_reminder_day — explicit column for fast
-- WHERE clause (cron query runs daily so we want index-friendly type).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE agency_subscriptions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE agency_subscriptions ADD COLUMN IF NOT EXISTS last_trial_reminder_day INT;
ALTER TABLE agency_subscriptions ADD COLUMN IF NOT EXISTS last_migration_reminder_at TIMESTAMPTZ;

-- Index — trial reminder cron daily lookup
CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_reminders
  ON agency_subscriptions(status, trial_ends_at)
  WHERE status = 'trial' AND legacy_pricing = false;

-- Index — migration reminder cron (legacy clients approaching deadline)
CREATE INDEX IF NOT EXISTS idx_subscriptions_legacy_deadline
  ON agency_subscriptions(legacy_migration_deadline)
  WHERE legacy_pricing = true;

COMMENT ON COLUMN agency_subscriptions.metadata IS 'JSONB grab-bag for non-critical subscription state (annual perk tracking, reminder timestamps, etc.)';
COMMENT ON COLUMN agency_subscriptions.last_trial_reminder_day IS 'Smallest day-bucket (7/3/1) for which we have already sent the trial reminder. Cron skips buckets ≥ this value.';
