-- ═══════════════════════════════════════════════════════
-- Pre-Departure: checklists / deadlines / files columns
-- ═══════════════════════════════════════════════════════
-- src/routes/pre-departure.js GET / SELECT pd.checklists, pd.deadlines, pd.files
-- Original supabase/migrations/007 + 008 — converted to deploy/ convention.

ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS checklists JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS deadlines  JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS files      JSONB NOT NULL DEFAULT '[]'::jsonb;
