-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_02_bot_knowledge_history.sql — Q&A version history.
--
-- Snapshot the OLD row before each PATCH/DELETE so admins can review past
-- versions and recover from accidental edits. Phase 1: snapshot table only;
-- a "view history" UI panel can be added later without migration changes.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bot_knowledge_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  knowledge_id    UUID NOT NULL,                       -- the bot_knowledge.id this snapshot belongs to
  agency_id       UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  -- Snapshot of the FORMER state (before update or before delete)
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  keywords        TEXT[] DEFAULT ARRAY[]::TEXT[],
  category        TEXT,
  min_role        TEXT,
  query_type      TEXT,
  permission_required TEXT,
  is_active       BOOLEAN,
  -- Metadata about the change
  change_type     TEXT NOT NULL,                       -- 'update' | 'delete'
  changed_by      UUID REFERENCES users(id),
  changed_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_history_agency
  ON bot_knowledge_history(agency_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_history_knowledge
  ON bot_knowledge_history(knowledge_id, changed_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agencybook') THEN
    EXECUTE 'GRANT ALL ON TABLE bot_knowledge_history TO agencybook';
  END IF;
END $$;
