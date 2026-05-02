-- ═══════════════════════════════════════════════════════════════════════
-- migration_ops_heartbeat.sql — Phase 3: Operator Console heartbeat
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adds `instance_heartbeats` table — every Tier A/B/C instance phones
-- home periodically with health + version + license status. The central
-- ops dashboard reads from here.
--
-- Lives in the central DB (agencybook_db) only. Tier A/B instances POST
-- their heartbeat to https://demo-api.agencybook.net/api/ops/heartbeat
-- using their license_key as auth.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS instance_heartbeats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_id TEXT NOT NULL,
  deployment_mode TEXT,                  -- shared-saas | dedicated | customer-vps | on-premise
  hostname TEXT,
  version TEXT,
  license_status TEXT,                   -- active | past_due | suspended | cancelled
  agencies_count INT DEFAULT 0,
  users_count INT DEFAULT 0,
  storage_mb NUMERIC,
  uptime_seconds BIGINT,
  memory_mb INT,
  error_count_24h INT DEFAULT 0,
  ip_address INET,
  reported_at TIMESTAMPTZ DEFAULT now()
);

-- Most-recent heartbeat per instance — for dashboard "current state"
CREATE INDEX IF NOT EXISTS idx_heartbeat_instance_recent
  ON instance_heartbeats(instance_id, reported_at DESC);

-- Time-series queries (e.g., "heartbeats in last 24h") use this
CREATE INDEX IF NOT EXISTS idx_heartbeat_reported_at
  ON instance_heartbeats(reported_at DESC);

-- View: last seen per instance (dashboard query)
CREATE OR REPLACE VIEW v_instance_last_seen AS
SELECT DISTINCT ON (instance_id)
  instance_id,
  deployment_mode,
  hostname,
  version,
  license_status,
  agencies_count,
  users_count,
  storage_mb,
  uptime_seconds,
  memory_mb,
  error_count_24h,
  reported_at,
  EXTRACT(EPOCH FROM (now() - reported_at))::INT AS seconds_since_heartbeat
FROM instance_heartbeats
ORDER BY instance_id, reported_at DESC;
