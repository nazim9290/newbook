-- Excel templates — agency-side resume/document templates.
-- Adds tags + many-to-many school link (junction table) so one template can
-- be linked to multiple schools (and one school sees multiple templates).
-- Idempotent — safe to re-run.

-- 1) tags column
ALTER TABLE excel_templates
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_excel_templates_tags
  ON excel_templates USING GIN (tags);

-- 2) Junction table — N excel_templates ↔ N schools
CREATE TABLE IF NOT EXISTS excel_template_schools (
  template_id UUID NOT NULL REFERENCES excel_templates(id) ON DELETE CASCADE,
  school_id   UUID NOT NULL REFERENCES schools(id)         ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (template_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_ets_school_id   ON excel_template_schools(school_id);
CREATE INDEX IF NOT EXISTS idx_ets_template_id ON excel_template_schools(template_id);

-- 3) Backfill — copy existing single-school links into the junction.
--    Skip rows where school_id is null.
INSERT INTO excel_template_schools (template_id, school_id)
SELECT id, school_id FROM excel_templates
WHERE school_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Notes:
--  • school_id (single FK) is kept for backward compat with read paths that haven't
--    been updated yet. Junction rows are the source of truth going forward.
--  • school_name is also kept for display (no FK; legacy column).

COMMENT ON COLUMN excel_templates.tags IS
  'Free-text tag list. Predefined: resume, agreement, application, interview, financial, certificate, other.';
COMMENT ON TABLE excel_template_schools IS
  'M:N link between agency excel_templates and schools. Source of truth — supersedes excel_templates.school_id.';
