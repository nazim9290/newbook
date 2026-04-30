-- Default templates — add tags + many-to-many school link.
-- Idempotent (uses IF NOT EXISTS) so safe to re-run.

-- 1) Tags column on default_templates (multi-tag, free-text + predefined values)
ALTER TABLE default_templates
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_default_templates_tags
  ON default_templates USING GIN (tags);

-- 2) Junction table — N templates ↔ N schools
CREATE TABLE IF NOT EXISTS default_template_schools (
  template_id UUID NOT NULL REFERENCES default_templates(id) ON DELETE CASCADE,
  school_id   UUID NOT NULL REFERENCES schools(id)            ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (template_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_dts_school_id   ON default_template_schools(school_id);
CREATE INDEX IF NOT EXISTS idx_dts_template_id ON default_template_schools(template_id);

-- 3) Comment for future maintainers
COMMENT ON COLUMN default_templates.tags IS
  'Free-text tag list. Predefined: resume, agreement, application, interview, financial, certificate, other. Used for filtering on Templates page + Resume builder.';

COMMENT ON TABLE default_template_schools IS
  'M:N link between default_templates and schools. NULL link (no row) = template is global (available for all schools).';
