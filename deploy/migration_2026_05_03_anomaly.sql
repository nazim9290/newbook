-- ════════════════════════════════════════════════════════════════════
-- Migration: Anomaly Alert / Security Watchdog (Owner Power-Up Phase 1)
-- Date: 2026-05-03
-- ════════════════════════════════════════════════════════════════════
-- Adds:
--   1. anomaly_rules    — per-agency rule config (toggle, threshold, recipients)
--   2. anomaly_events   — log of triggered anomalies
--   3. failed_login_attempts — counter for brute-force detection
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. anomaly_rules — per-agency toggleable detection rules
CREATE TABLE IF NOT EXISTS anomaly_rules (
  id              BIGSERIAL PRIMARY KEY,
  agency_id       UUID NOT NULL,
  rule_type       TEXT NOT NULL,        -- bulk_delete | after_hours | failed_login | large_payment | large_refund | fee_waiver
  threshold       NUMERIC,              -- meaning depends on rule_type
  enabled         BOOLEAN DEFAULT TRUE,
  cooldown_minutes INT DEFAULT 60,
  last_triggered_at TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agency_id, rule_type)
);

CREATE INDEX IF NOT EXISTS idx_anomaly_rules_agency
  ON anomaly_rules(agency_id, enabled);

-- 2. anomaly_events — log of detections (notified/not yet)
CREATE TABLE IF NOT EXISTS anomaly_events (
  id                 BIGSERIAL PRIMARY KEY,
  agency_id          UUID NOT NULL,
  rule_id            BIGINT REFERENCES anomaly_rules(id) ON DELETE SET NULL,
  rule_type          TEXT NOT NULL,
  triggered_by_user  UUID,                          -- actor who caused the trigger
  details            JSONB,                          -- record_ids, amounts, etc.
  notification_id    BIGINT REFERENCES notifications_sent(id) ON DELETE SET NULL,
  notified           BOOLEAN DEFAULT FALSE,
  acknowledged_at    TIMESTAMPTZ,
  acknowledged_by    UUID,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_agency_time
  ON anomaly_events(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_rule_type
  ON anomaly_events(rule_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_unack
  ON anomaly_events(agency_id, acknowledged_at) WHERE acknowledged_at IS NULL;

-- 3. failed_login_attempts — sliding window counter
CREATE TABLE IF NOT EXISTS failed_login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  agency_id   UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_login_email_time
  ON failed_login_attempts(email, created_at DESC);

-- 4. Seed default rules for every existing agency
INSERT INTO anomaly_rules (agency_id, rule_type, threshold, enabled, cooldown_minutes)
SELECT a.id, r.rule_type, r.threshold, TRUE, r.cooldown
FROM agencies a
CROSS JOIN (VALUES
  ('bulk_delete'::TEXT,    10::NUMERIC,    60::INT),
  ('after_hours',          1,              120),
  ('failed_login',         5,              30),
  ('large_payment',        100000,         60),
  ('large_refund',         50000,          60),
  ('fee_waiver',           10000,          60)
) AS r(rule_type, threshold, cooldown)
ON CONFLICT (agency_id, rule_type) DO NOTHING;

COMMENT ON TABLE anomaly_rules  IS 'Per-agency toggleable detection rules — owner-tunable';
COMMENT ON TABLE anomaly_events IS 'Triggered anomalies log';
COMMENT ON TABLE failed_login_attempts IS 'Sliding window for brute-force detection';

COMMIT;
