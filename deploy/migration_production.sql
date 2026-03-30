-- ══════════════════════════════════════════════════════════════
-- AgencyBook Production Migration — Missing Columns + Indexes
-- Run: psql -U agencybook -h 127.0.0.1 -d agencybook_db -f deploy/migration_production.sql
-- Safe: সব IF NOT EXISTS — বারবার চালানো যাবে
-- ══════════════════════════════════════════════════════════════

-- ── 1. Missing agency_id columns ──
ALTER TABLE batch_students ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES agencies(id);
ALTER TABLE class_tests ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES agencies(id);
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE fee_items ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES agencies(id);
ALTER TABLE partner_students ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES agencies(id);
ALTER TABLE sponsor_banks ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE student_education ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE student_family ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE student_jp_exams ADD COLUMN IF NOT EXISTS agency_id UUID;

-- ── 2. Missing updated_at columns ──
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE batch_students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE batch_students ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE billing_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE class_tests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE fee_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE portal_form_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE salary_history ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE sponsor_banks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE student_education ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE student_family ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE student_jp_exams ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── 3. Missing functional columns (আগের bug fix থেকে) ──
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS last_recheck_date DATE;
ALTER TABLE document_data ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS interview_template TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS interview_template_name TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS interview_template_mapping TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS intakes TEXT[];
ALTER TABLE visitors ADD COLUMN IF NOT EXISTS display_id TEXT;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS condition TEXT DEFAULT 'new';
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS vendor TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS purchase_date DATE;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS warranty TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE excel_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE salary_history ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE salary_history ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'paid';
ALTER TABLE salary_history ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_access BOOLEAN DEFAULT false;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_password_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_sections JSONB DEFAULT '[]'::jsonb;
ALTER TABLE students ADD COLUMN IF NOT EXISTS last_portal_login TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'own';
ALTER TABLE students ADD COLUMN IF NOT EXISTS permanent_address TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS current_address TEXT;

-- ── 4. Performance indexes ──
CREATE INDEX IF NOT EXISTS idx_students_agency ON students(agency_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(agency_id, status);
CREATE INDEX IF NOT EXISTS idx_students_batch ON students(batch_id);
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_students_branch ON students(agency_id, branch);
CREATE INDEX IF NOT EXISTS idx_visitors_agency ON visitors(agency_id);
CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(agency_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_agency ON payments(agency_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_expenses_agency ON expenses(agency_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date, batch_id);
CREATE INDEX IF NOT EXISTS idx_submissions_school ON submissions(school_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agency ON tasks(agency_id);
CREATE INDEX IF NOT EXISTS idx_communications_agency ON communications(agency_id);
CREATE INDEX IF NOT EXISTS idx_calendar_agency ON calendar_events(agency_id, date);
CREATE INDEX IF NOT EXISTS idx_documents_student ON documents(student_id);
CREATE INDEX IF NOT EXISTS idx_agents_agency ON agents(agency_id);
CREATE INDEX IF NOT EXISTS idx_inventory_agency ON inventory(agency_id);
CREATE INDEX IF NOT EXISTS idx_employees_agency ON employees(agency_id);

-- ── 5. Backfill agency_id for child tables (demo agency) ──
UPDATE batch_students SET agency_id = 'a0000000-0000-0000-0000-000000000001' WHERE agency_id IS NULL;
UPDATE class_tests SET agency_id = (SELECT agency_id FROM batches WHERE batches.id = class_tests.batch_id LIMIT 1) WHERE agency_id IS NULL;
UPDATE fee_items SET agency_id = 'a0000000-0000-0000-0000-000000000001' WHERE agency_id IS NULL;
UPDATE salary_history SET agency_id = 'a0000000-0000-0000-0000-000000000001' WHERE agency_id IS NULL;
UPDATE sponsors SET agency_id = 'a0000000-0000-0000-0000-000000000001' WHERE agency_id IS NULL;

-- ══════════════════════════════════════
-- Migration Complete!
-- ══════════════════════════════════════
