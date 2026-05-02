-- ════════════════════════════════════════════════════════════════════
-- Migration: Document Expiry Alert system (Owner Power-Up Phase 1)
-- Date: 2026-05-03
-- ════════════════════════════════════════════════════════════════════
-- Adds:
--   1. students.visa_expiry, coe_received_date, coe_validity_days
--   2. expiry_alerts_sent table — duplicate prevention for daily scans
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. New date columns on students
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS visa_expiry          DATE,
  ADD COLUMN IF NOT EXISTS coe_received_date    DATE,
  ADD COLUMN IF NOT EXISTS coe_validity_days    INT DEFAULT 90;

-- 2. Alerts-sent log — duplicate prevention per (student, field, expiry_date)
CREATE TABLE IF NOT EXISTS expiry_alerts_sent (
  id              BIGSERIAL PRIMARY KEY,
  agency_id       UUID NOT NULL,
  student_id      TEXT NOT NULL,
  field           TEXT NOT NULL,        -- 'passport' | 'visa' | 'coe' | 'school_deadline'
  expiry_date     DATE NOT NULL,
  days_remaining  INT NOT NULL,
  notification_id BIGINT REFERENCES notifications_sent(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_id, field, expiry_date)
);

CREATE INDEX IF NOT EXISTS idx_expiry_alerts_agency_time
  ON expiry_alerts_sent(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expiry_alerts_student
  ON expiry_alerts_sent(student_id, created_at DESC);

COMMENT ON TABLE expiry_alerts_sent IS 'Idempotency guard: prevents repeat alerts for same expiry on same date';

COMMIT;
