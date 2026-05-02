-- ═══════════════════════════════════════════════════════════════════════
-- migration_public_api.sql — Phase 13: Public API + Webhooks
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adds:
--   * api_keys           — per-agency API keys with rate-limit tier + scopes
--   * webhook_endpoints  — registered URLs to fire on events
--   * webhook_deliveries — delivery attempts log (success + retry tracking)
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- e.g. "Zapier integration"
  prefix TEXT NOT NULL,                    -- displayable: 'agbk_live_abc123' (first 16 chars)
  key_hash TEXT NOT NULL,                  -- bcrypt hash of full key
  scopes TEXT[] DEFAULT ARRAY['read'],     -- 'read' | 'write' | 'admin'
  rate_limit_rpm INT DEFAULT 60,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_agency ON api_keys(agency_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,                  -- e.g. ['student.created', 'invoice.paid']
  secret TEXT NOT NULL,                    -- HMAC-SHA256 secret for X-Signature header
  is_active BOOLEAN DEFAULT true,
  failure_count INT DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_agency_active ON webhook_endpoints(agency_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempt INT DEFAULT 1,
  status_code INT,
  response_body TEXT,
  succeeded BOOLEAN DEFAULT false,
  delivered_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook_recent ON webhook_deliveries(webhook_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_failed ON webhook_deliveries(succeeded, delivered_at DESC) WHERE succeeded = false;
