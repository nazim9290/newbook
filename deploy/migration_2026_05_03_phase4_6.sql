-- ════════════════════════════════════════════════════════════════════
-- Migration: Phase 4 + 5 + 6 — Provider integrations + AI + Compliance
-- Date: 2026-05-03
-- ════════════════════════════════════════════════════════════════════
-- Adds:
--   F12 chat_threads + chat_messages (AI Counselor Assistant)
--   F15 inbound_webhooks + webhook_events (lead capture from external)
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- F12 — AI Counselor Assistant (per-user chat threads)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_threads (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id    UUID NOT NULL,
  user_id      UUID NOT NULL,
  title        TEXT,
  context_type TEXT,                          -- 'student' | 'visitor' | 'school' | 'general'
  context_id   TEXT,                          -- the linked record's id
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  tokens_in   INT,
  tokens_out  INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);

-- ────────────────────────────────────────────────────────────────────
-- F15 — Inbound Webhook Hub
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbound_webhooks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id       UUID NOT NULL,
  name            TEXT NOT NULL,
  source_type     TEXT NOT NULL,             -- 'web_form' | 'meta_lead' | 'whatsapp_inbound' | 'generic_json' | 'zapier'
  webhook_token   TEXT UNIQUE NOT NULL,      -- secret in URL — opaque random
  target_action   TEXT NOT NULL,             -- 'create_visitor' | 'create_task' | 'log_only'
  field_mapping   JSONB,                     -- { "name": "data.full_name", ... }
  enabled         BOOLEAN DEFAULT TRUE,
  created_by      UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbound_webhooks_token ON inbound_webhooks(webhook_token) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS webhook_events (
  id              BIGSERIAL PRIMARY KEY,
  webhook_id      UUID REFERENCES inbound_webhooks(id) ON DELETE CASCADE,
  agency_id       UUID NOT NULL,
  payload         JSONB,
  result_status   TEXT,                      -- 'created' | 'duplicate' | 'failed'
  result_message  TEXT,
  created_record_id TEXT,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_agency ON webhook_events(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook ON webhook_events(webhook_id, created_at DESC);

COMMENT ON TABLE chat_threads      IS 'AI Counselor Assistant — per-user/per-context threads';
COMMENT ON TABLE chat_messages     IS 'Messages within a chat thread (alternating user/assistant)';
COMMENT ON TABLE inbound_webhooks  IS 'External form/API endpoints that auto-create visitors/tasks';
COMMENT ON TABLE webhook_events    IS 'Inbound webhook delivery log';

COMMIT;
