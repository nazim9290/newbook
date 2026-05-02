-- migration_byok_integrations.sql
-- Per-agency BYOK (Bring Your Own Key) integration credentials.
--
-- Each agency on Pro/Business tier (or any agency on an enterprise install)
-- can store their own API keys for external services. The backend resolver
-- (lib/integrations.js) prefers agency-provided keys, falls back to platform
-- defaults from .env when INSTANCE_MODE=shared, or errors out when
-- INSTANCE_MODE=enterprise.
--
-- Credentials are stored encrypted via lib/crypto.encrypt (AES-256-GCM).
-- The DB never sees plaintext.
--
-- Append-only. Safe to re-run.

CREATE TABLE IF NOT EXISTS agency_integrations (
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  service       TEXT NOT NULL,
  -- JSONB of {field: encrypted_string}. Each value is the output of
  -- lib/crypto.encrypt — i.e. "iv:authTag:ciphertext" hex.
  credentials   JSONB NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Last time the resolver / a manual test verified the credentials work
  validated_at  TIMESTAMPTZ,
  -- If validation failed, the error message (helps owner debug from UI)
  last_error    TEXT,
  -- Audit trail — who configured this
  created_by    UUID,
  updated_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, service),
  CONSTRAINT valid_service CHECK (service IN ('anthropic', 'r2', 'smtp', 'stripe'))
);

-- Per-agency monthly usage counter for services where the platform key is
-- being used (i.e. agency hasn't BYOK'd yet). Quota enforcement reads this.
-- Period is YYYY-MM (UTC); rolls over monthly.
CREATE TABLE IF NOT EXISTS agency_api_usage (
  agency_id      UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,
  period         TEXT NOT NULL,
  call_count     INT  NOT NULL DEFAULT 0,
  last_called_at TIMESTAMPTZ,
  PRIMARY KEY (agency_id, service, period)
);

CREATE INDEX IF NOT EXISTS idx_agency_api_usage_period
  ON agency_api_usage(period, service);

-- Quota defaults per tier (when agency uses platform key, how many calls/month free)
-- Stored as a settings row in subscription_plans.features.platform_quota.<service>.
-- Example: starter.features.platform_quota.anthropic = 50
-- (We extend the existing JSONB; no schema change needed.)
--
-- Backfill the platform_quota field for existing plans (idempotent — only
-- adds the key if missing, doesn't overwrite if admin tuned it):
UPDATE subscription_plans
SET features = features || jsonb_build_object(
  'platform_quota', COALESCE(features->'platform_quota', '{}'::jsonb) || jsonb_build_object(
    'anthropic', CASE code
      WHEN 'starter'      THEN 50
      WHEN 'professional' THEN 1000
      WHEN 'business'     THEN 5000
      WHEN 'enterprise'   THEN -1   -- -1 means unlimited (mostly relevant for shared mode)
      ELSE 0
    END,
    'r2_gb', CASE code
      WHEN 'starter'      THEN 2.5
      WHEN 'professional' THEN 10
      WHEN 'business'     THEN 25
      WHEN 'enterprise'   THEN -1
      ELSE 0
    END,
    'smtp_per_day', CASE code
      WHEN 'starter'      THEN 50
      WHEN 'professional' THEN 500
      WHEN 'business'     THEN 5000
      WHEN 'enterprise'   THEN -1
      ELSE 0
    END
  )
)
WHERE features->'platform_quota' IS NULL OR features->'platform_quota' = '{}'::jsonb;
