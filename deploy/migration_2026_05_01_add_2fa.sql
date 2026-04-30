-- ════════════════════════════════════════════════════════════════════
-- Migration: Two-Factor Authentication (TOTP) — 2026-05-01
-- ════════════════════════════════════════════════════════════════════
-- Adds TOTP/2FA columns to users table and creates auth_2fa_events
-- audit log. Safe additive migration: all new columns are nullable
-- with sensible defaults; existing rows keep working.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Extend users table ──
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret        TEXT,                       -- AES-256-GCM encrypted base32
  ADD COLUMN IF NOT EXISTS totp_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_required      BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_backup_codes  TEXT,                       -- JSON array of SHA-256 hashes
  ADD COLUMN IF NOT EXISTS last_2fa_at        TIMESTAMPTZ;

-- ── 2. Audit log table for 2FA events ──
CREATE TABLE IF NOT EXISTS auth_2fa_events (
  id          BIGSERIAL PRIMARY KEY,
  agency_id   UUID        NOT NULL,
  user_id     UUID        NOT NULL,
  actor_id    UUID,                          -- NULL when self, set when admin acted
  event       TEXT        NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_2fa_events_user_created  ON auth_2fa_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_2fa_events_agency_created ON auth_2fa_events (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_2fa_events_event_created ON auth_2fa_events (event, created_at DESC);

COMMENT ON COLUMN users.totp_secret       IS 'AES-256-GCM encrypted base32 TOTP secret';
COMMENT ON COLUMN users.totp_enabled      IS 'TRUE after user completes setup-verify';
COMMENT ON COLUMN users.totp_required     IS 'Admin-set flag — user must enroll on next login';
COMMENT ON COLUMN users.totp_backup_codes IS 'JSON array of SHA-256 hex hashes; codes consumed on use';
COMMENT ON TABLE  auth_2fa_events         IS '2FA audit trail: enrolled, verified, admin_enabled, etc.';

COMMIT;
