-- ═══════════════════════════════════════════════════════
-- Sessions / Intakes master — student intake (April 2027, October 2027 etc.)
-- ═══════════════════════════════════════════════════════
-- src/routes/sessions.js
-- Used by: Student/Visitor form intake dropdown, Settings → Sessions tab

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                      -- e.g. "April 2027"
  country      TEXT,                               -- e.g. "Japan", "Germany"
  start_date   DATE,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'active',     -- active / archived
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One session name per agency
  UNIQUE (agency_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sessions_agency_status ON sessions(agency_id, status);
