-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_02_help_bot.sql — Per-agency knowledge base for in-app
-- help bot. Each agency owner/admin curates Q&A; bot answers ONLY from this
-- table (no LLM call). Trigram + ILIKE matching for typos & fuzzy search.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS bot_knowledge (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id    UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  keywords     TEXT[] DEFAULT ARRAY[]::TEXT[],   -- synonyms / alt-phrasings
  category     TEXT,                              -- e.g. 'visitors', 'students', 'general'
  is_active    BOOLEAN DEFAULT TRUE,
  hits         INTEGER DEFAULT 0,                 -- usage counter
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_agency
  ON bot_knowledge(agency_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_category
  ON bot_knowledge(agency_id, category) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_question_trgm
  ON bot_knowledge USING gin (question gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bot_knowledge_answer_trgm
  ON bot_knowledge USING gin (answer gin_trgm_ops);

-- Per-conversation log so admins can see what users asked & whether bot found
-- an answer (useful to identify gaps in the knowledge base).
CREATE TABLE IF NOT EXISTS bot_conversations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  question      TEXT NOT NULL,
  matched_id    UUID REFERENCES bot_knowledge(id) ON DELETE SET NULL,
  matched_score REAL,                             -- 0..1; NULL if no match
  page_context  TEXT,                             -- which app page user was on
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_conversations_agency_recent
  ON bot_conversations(agency_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_conversations_unmatched
  ON bot_conversations(agency_id, created_at DESC) WHERE matched_id IS NULL;

-- Grant to app user (idempotent — fine to re-run)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agencybook') THEN
    EXECUTE 'GRANT ALL ON TABLE bot_knowledge, bot_conversations TO agencybook';
  END IF;
END $$;
