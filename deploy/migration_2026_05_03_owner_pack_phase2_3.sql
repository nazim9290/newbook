-- ════════════════════════════════════════════════════════════════════
-- Migration: Owner Power-Up Pack — Phase 2 + 3 (combined)
-- Date: 2026-05-03
-- ════════════════════════════════════════════════════════════════════
-- Adds:
--   F4  broadcast_campaigns + broadcast_recipients + message_templates
--   F7  pipeline_stage_probabilities (cash flow forecast)
--   F8  push_subscriptions (Web Push API)
--   F10 feedback_surveys (NPS / reviews)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- F4 — Broadcast (WhatsApp/SMS bulk messaging) — schema only, infra ready
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_templates (
  id                      BIGSERIAL PRIMARY KEY,
  agency_id               UUID NOT NULL,
  name                    TEXT NOT NULL,
  channel                 TEXT NOT NULL,            -- 'whatsapp' | 'sms' | 'email'
  body                    TEXT NOT NULL,            -- supports {name}, {batch} etc.
  whatsapp_template_name  TEXT,                     -- Meta-approved template ID
  category                TEXT,                     -- marketing | reminder | alert
  created_by              UUID,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msg_templates_agency ON message_templates(agency_id);

CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  id                BIGSERIAL PRIMARY KEY,
  agency_id         UUID NOT NULL,
  template_id       BIGINT REFERENCES message_templates(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  audience_filter   JSONB,                          -- {status:"interested",country:"Japan"}
  total_recipients  INT DEFAULT 0,
  sent_count        INT DEFAULT 0,
  failed_count      INT DEFAULT 0,
  status            TEXT DEFAULT 'draft',           -- draft | sending | done | failed | cancelled
  scheduled_at      TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_by        UUID,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bcc_agency_time ON broadcast_campaigns(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bcc_status ON broadcast_campaigns(status, scheduled_at) WHERE status IN ('draft','sending');

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id              BIGSERIAL PRIMARY KEY,
  campaign_id     BIGINT REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
  recipient_type  TEXT NOT NULL,                    -- visitor | student
  recipient_id    TEXT NOT NULL,
  phone           TEXT,
  status          TEXT DEFAULT 'queued',            -- queued | sent | failed | delivered | read
  external_id     TEXT,                             -- provider message ID
  error           TEXT,
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bcr_campaign_status ON broadcast_recipients(campaign_id, status);

-- ────────────────────────────────────────────────────────────────────
-- F7 — Cash Flow Forecast — pipeline stage probabilities
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_stage_probabilities (
  id                       BIGSERIAL PRIMARY KEY,
  agency_id                UUID NOT NULL,
  pipeline_status          TEXT NOT NULL,
  probability              NUMERIC NOT NULL DEFAULT 0,    -- 0.0 to 1.0
  avg_days_to_complete     INT DEFAULT 90,
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agency_id, pipeline_status)
);

-- Seed default probabilities for every existing agency
INSERT INTO pipeline_stage_probabilities (agency_id, pipeline_status, probability, avg_days_to_complete)
SELECT a.id, p.status, p.prob, p.days
FROM agencies a
CROSS JOIN (VALUES
  ('VISITOR'::TEXT,          0.05::NUMERIC, 240::INT),
  ('FOLLOW_UP',              0.15,          210),
  ('ENROLLED',               0.40,          180),
  ('IN_COURSE',              0.55,          150),
  ('EXAM_PASSED',            0.65,          120),
  ('DOC_COLLECTION',         0.75,          90),
  ('SCHOOL_INTERVIEW',       0.80,          75),
  ('DOC_SUBMITTED',          0.85,          60),
  ('COE_RECEIVED',           0.92,          45),
  ('VISA_GRANTED',           0.98,          30),
  ('ARRIVED',                1.00,          0)
) AS p(status, prob, days)
ON CONFLICT (agency_id, pipeline_status) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- F8 — Web Push subscriptions
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  agency_id       UUID NOT NULL,
  user_id         UUID NOT NULL,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  topics          TEXT[] DEFAULT ARRAY['all'],
  enabled         BOOLEAN DEFAULT TRUE,
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_push_sub_agency ON push_subscriptions(agency_id) WHERE enabled = TRUE;

-- ────────────────────────────────────────────────────────────────────
-- F10 — Feedback / NPS surveys
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_surveys (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id            UUID NOT NULL,
  student_id           TEXT NOT NULL,
  trigger_event        TEXT NOT NULL,           -- enrolled | coe_received | arrived | 6_months_in_japan
  nps_score            INT,                     -- 0–10
  rating               INT,                     -- 1–5 stars
  text_review          TEXT,
  is_public            BOOLEAN DEFAULT FALSE,
  consent_given        BOOLEAN DEFAULT FALSE,
  language             TEXT DEFAULT 'bn',
  link_token           TEXT UNIQUE,             -- one-time URL token
  link_expires_at      TIMESTAMPTZ,
  submitted_at         TIMESTAMPTZ,
  invitation_sent_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_agency_time ON feedback_surveys(agency_id, submitted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_feedback_token ON feedback_surveys(link_token) WHERE link_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_public ON feedback_surveys(agency_id, is_public) WHERE is_public = TRUE;

-- ────────────────────────────────────────────────────────────────────
-- Feature flags + new agency_settings columns for Phase 2/3
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE agency_settings
  ADD COLUMN IF NOT EXISTS enable_broadcast       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS enable_forecasting     BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS enable_nps             BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS enable_push            BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS broadcast_daily_limit  INT DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS broadcast_sent_today   INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS broadcast_reset_date   DATE;

COMMENT ON TABLE  broadcast_campaigns           IS 'Bulk WhatsApp/SMS campaigns — disabled by default; owner must configure provider creds';
COMMENT ON TABLE  pipeline_stage_probabilities  IS 'Per-agency conversion probabilities for cash-flow forecast';
COMMENT ON TABLE  push_subscriptions            IS 'Web Push API subscriptions per user';
COMMENT ON TABLE  feedback_surveys              IS 'NPS / review tokens issued to students post-trigger';

COMMIT;
