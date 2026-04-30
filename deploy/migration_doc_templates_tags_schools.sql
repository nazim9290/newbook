-- Doc Generator templates — agency-side .docx templates (Translation, Certificate, Letter…).
-- Adds tags + many-to-many school link, mirroring excel_templates pattern.
-- Idempotent.

ALTER TABLE doc_templates
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_doc_templates_tags
  ON doc_templates USING GIN (tags);

CREATE TABLE IF NOT EXISTS doc_template_schools (
  template_id UUID NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
  school_id   UUID NOT NULL REFERENCES schools(id)       ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (template_id, school_id)
);

CREATE INDEX IF NOT EXISTS idx_dts_doc_school   ON doc_template_schools(school_id);
CREATE INDEX IF NOT EXISTS idx_dts_doc_template ON doc_template_schools(template_id);

COMMENT ON COLUMN doc_templates.tags IS
  'Free-text tag list. Predefined: resume, agreement, application, interview, financial, certificate, other.';
COMMENT ON TABLE doc_template_schools IS
  'M:N link between agency doc_templates (Translation/Certificate/Letter) and schools.';
