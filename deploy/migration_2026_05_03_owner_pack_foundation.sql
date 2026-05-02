-- ════════════════════════════════════════════════════════════════════
-- Migration: Owner Power-Up Pack — Foundation tables (Phase 1)
-- Date: 2026-05-03
-- ════════════════════════════════════════════════════════════════════
-- Adds shared infrastructure used by Doc Expiry, Backup, and Anomaly
-- features:
--   1. agency_settings        — owner-tunable thresholds + provider creds
--   2. notification_subscriptions — who gets which alert via which channel
--   3. notifications_sent     — outbox + delivery audit log
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- 1. agency_settings — per-agency configuration
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agency_settings (
  agency_id UUID PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,

  -- Doc expiry thresholds (days before expiry to alert)
  doc_expiry_warn_days       INT DEFAULT 180,    -- passport: 6 months
  visa_expiry_warn_days      INT DEFAULT 30,
  coe_expiry_warn_days       INT DEFAULT 14,
  school_deadline_warn_days  INT DEFAULT 30,

  -- Anomaly thresholds
  anomaly_after_hours_start         TIME    DEFAULT '23:00',
  anomaly_after_hours_end           TIME    DEFAULT '06:00',
  anomaly_bulk_delete_threshold     INT     DEFAULT 10,
  anomaly_failed_login_threshold    INT     DEFAULT 5,
  anomaly_failed_login_window_min   INT     DEFAULT 15,
  large_payment_threshold           NUMERIC DEFAULT 100000,    -- ৳1L
  large_refund_threshold            NUMERIC DEFAULT 50000,
  fee_waiver_threshold              NUMERIC DEFAULT 10000,

  -- Feature flags
  enable_doc_expiry_alerts   BOOLEAN DEFAULT TRUE,
  enable_anomaly_alerts      BOOLEAN DEFAULT TRUE,
  enable_offsite_backup      BOOLEAN DEFAULT FALSE,

  -- Backup config (Phase 1 Feature 2)
  backup_target              TEXT,                       -- 'gdrive' | 's3' | 'r2'
  backup_credentials         TEXT,                       -- AES-256 encrypted JSON
  backup_drive_folder_id     TEXT,
  backup_last_success        TIMESTAMPTZ,
  backup_last_error          TEXT,
  backup_retention_days      INT DEFAULT 30,
  backup_schedule_cron       TEXT DEFAULT '0 2 * * *',   -- daily 02:00

  -- Provider creds for later phases (Phase 2/3) — encrypted at rest
  whatsapp_api_token         TEXT,
  whatsapp_phone_number_id   TEXT,
  sms_api_key                TEXT,
  sms_provider               TEXT,       -- 'sslwireless' | 'bdsms' | etc.
  brevo_api_key              TEXT,       -- per-agency override of system default
  telegram_bot_token         TEXT,       -- if agency wants own bot

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Defensive: if table already existed without these columns, add them
ALTER TABLE agency_settings
  ADD COLUMN IF NOT EXISTS doc_expiry_warn_days INT DEFAULT 180,
  ADD COLUMN IF NOT EXISTS visa_expiry_warn_days INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS coe_expiry_warn_days INT DEFAULT 14,
  ADD COLUMN IF NOT EXISTS school_deadline_warn_days INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS anomaly_after_hours_start TIME DEFAULT '23:00',
  ADD COLUMN IF NOT EXISTS anomaly_after_hours_end TIME DEFAULT '06:00',
  ADD COLUMN IF NOT EXISTS anomaly_bulk_delete_threshold INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS anomaly_failed_login_threshold INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS anomaly_failed_login_window_min INT DEFAULT 15,
  ADD COLUMN IF NOT EXISTS large_payment_threshold NUMERIC DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS large_refund_threshold NUMERIC DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS fee_waiver_threshold NUMERIC DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS enable_doc_expiry_alerts BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS enable_anomaly_alerts BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS enable_offsite_backup BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backup_target TEXT,
  ADD COLUMN IF NOT EXISTS backup_credentials TEXT,
  ADD COLUMN IF NOT EXISTS backup_drive_folder_id TEXT,
  ADD COLUMN IF NOT EXISTS backup_last_success TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS backup_last_error TEXT,
  ADD COLUMN IF NOT EXISTS backup_retention_days INT DEFAULT 30,
  ADD COLUMN IF NOT EXISTS backup_schedule_cron TEXT DEFAULT '0 2 * * *',
  ADD COLUMN IF NOT EXISTS whatsapp_api_token TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS sms_api_key TEXT,
  ADD COLUMN IF NOT EXISTS sms_provider TEXT,
  ADD COLUMN IF NOT EXISTS brevo_api_key TEXT,
  ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Seed: every existing agency gets a default settings row
INSERT INTO agency_settings (agency_id)
  SELECT id FROM agencies
  ON CONFLICT (agency_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- 2. notification_subscriptions — who wants what
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  agency_id    UUID NOT NULL,
  user_id      UUID NOT NULL,
  channel      TEXT NOT NULL,        -- 'email' | 'telegram' | 'push' | 'sms' | 'whatsapp'
  destination  TEXT NOT NULL,        -- email addr / chat_id / push endpoint / phone
  topic        TEXT NOT NULL,        -- 'doc_expiry' | 'anomaly' | 'backup_failed' | 'payment' | 'all'
  enabled      BOOLEAN DEFAULT TRUE,
  metadata     JSONB,                -- VAPID keys, telegram chat_id, etc.
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, channel, destination, topic)
);

CREATE INDEX IF NOT EXISTS idx_notif_sub_user_topic
  ON notification_subscriptions(user_id, topic) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_notif_sub_agency_topic
  ON notification_subscriptions(agency_id, topic) WHERE enabled = TRUE;

-- ────────────────────────────────────────────────────────────────────
-- 3. notifications_sent — outbox + delivery audit
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications_sent (
  id           BIGSERIAL PRIMARY KEY,
  agency_id    UUID NOT NULL,
  user_id      UUID,                          -- recipient user, NULL if external
  channel      TEXT NOT NULL,                 -- email | telegram | push | sms | whatsapp
  template     TEXT NOT NULL,                 -- 'doc_expiry' | 'anomaly_bulk_delete' | etc.
  destination  TEXT NOT NULL,                 -- where it actually went
  subject      TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',-- queued | sent | failed | delivered | read
  error        TEXT,
  data         JSONB,                         -- template variables
  external_id  TEXT,                          -- provider message ID for callbacks
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_sent_agency_time
  ON notifications_sent(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_sent_status
  ON notifications_sent(status, created_at DESC) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_notif_sent_template
  ON notifications_sent(template, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Comments for documentation
-- ────────────────────────────────────────────────────────────────────
COMMENT ON TABLE  agency_settings              IS 'Owner-tunable per-agency settings: thresholds, feature flags, provider creds';
COMMENT ON COLUMN agency_settings.backup_credentials IS 'AES-256-GCM encrypted JSON (Drive service account or S3 keys)';
COMMENT ON TABLE  notification_subscriptions    IS 'Per-user opt-in for alert topics across channels';
COMMENT ON TABLE  notifications_sent           IS 'Outbox + delivery audit; provider callbacks update status';

COMMIT;
