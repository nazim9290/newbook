-- ================================================================
-- AgencyOS — Full Production Schema
-- Migration 001: All tables, indexes, triggers
-- ================================================================

-- ================================================================
-- CLEAN UP: Drop all old tables from previous schema
-- ================================================================
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS inventory CASCADE;
DROP TABLE IF EXISTS calendar_events CASCADE;
DROP TABLE IF EXISTS class_test_scores CASCADE;
DROP TABLE IF EXISTS class_tests CASCADE;
DROP TABLE IF EXISTS excel_templates CASCADE;
DROP TABLE IF EXISTS salary_history CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS communications CASCADE;
DROP TABLE IF EXISTS payment_installments CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS income CASCADE;
DROP TABLE IF EXISTS attendance CASCADE;
DROP TABLE IF EXISTS batch_students CASCADE;
DROP TABLE IF EXISTS submissions CASCADE;
DROP TABLE IF EXISTS document_fields CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS sponsor_banks CASCADE;
DROP TABLE IF EXISTS sponsors CASCADE;
DROP TABLE IF EXISTS sponsor CASCADE;
DROP TABLE IF EXISTS student_family CASCADE;
DROP TABLE IF EXISTS student_jp_exams CASCADE;
DROP TABLE IF EXISTS student_education CASCADE;
DROP TABLE IF EXISTS jp_exams CASCADE;
DROP TABLE IF EXISTS jp_study CASCADE;
DROP TABLE IF EXISTS employment CASCADE;
DROP TABLE IF EXISTS education CASCADE;
DROP TABLE IF EXISTS fee_items CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS batches CASCADE;
DROP TABLE IF EXISTS schools CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS visitors CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS agencies CASCADE;

-- Drop old functions
DROP FUNCTION IF EXISTS current_user_agency_id() CASCADE;
DROP FUNCTION IF EXISTS current_user_role() CASCADE;
DROP FUNCTION IF EXISTS current_user_id() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS handle_user_delete() CASCADE;

-- ================================================================
-- CREATE SCHEMA
-- ================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ================================================================
-- 1. AGENCIES (multi-tenant root)
-- ================================================================
CREATE TABLE agencies (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subdomain   TEXT UNIQUE NOT NULL,                -- e.g. "dhaka-education"
  name        TEXT NOT NULL,
  name_bn     TEXT,
  phone       TEXT,
  email       TEXT,
  trade_license TEXT,
  tin         TEXT,
  logo_url    TEXT,
  address     TEXT,
  settings    JSONB DEFAULT '{}'::jsonb,            -- branding, defaults, feature flags
  status      TEXT NOT NULL DEFAULT 'active',       -- active, suspended, trial
  plan        TEXT DEFAULT 'free',                  -- free, pro, enterprise
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 2. USERS (staff accounts, linked to agency)
-- ================================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  auth_user_id  UUID UNIQUE,                        -- links to auth.users
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'counselor',   -- owner, manager, counselor, accountant, staff, viewer
  branch        TEXT DEFAULT 'Main',
  permissions   JSONB DEFAULT '{}'::jsonb,           -- { modules: { students: { read:true, write:true, delete:false } } }
  avatar_url    TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agency_id, email)
);

-- ================================================================
-- 3. VISITORS (lead tracking)
-- ================================================================
CREATE TABLE visitors (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id             UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  name_bn               TEXT,
  phone                 TEXT NOT NULL,
  guardian_phone        TEXT,
  email                 TEXT,
  dob                   DATE,
  gender                TEXT,                       -- Male, Female, Other
  blood_group           TEXT,
  address               TEXT,
  education             JSONB DEFAULT '[]'::jsonb,  -- [{ level, year, board, gpa, subject }]
  has_jp_cert           BOOLEAN DEFAULT false,
  jp_exam_type          TEXT,                       -- JLPT, NAT, JFT, etc.
  jp_level              TEXT,                       -- N5, N4, N3, N2, N1
  jp_score              TEXT,
  visa_type             TEXT,                       -- Language Student, SSW, TITP, etc.
  interested_countries  TEXT[] DEFAULT '{Japan}',
  interested_intake     TEXT,                       -- April 2026, October 2026
  budget_concern        BOOLEAN DEFAULT false,
  source                TEXT DEFAULT 'Walk-in',     -- Walk-in, Facebook, Agent, Referral, Website, YouTube
  agent_id              UUID,                       -- FK added after agents table
  referral_info         TEXT,
  counselor             TEXT,
  branch                TEXT,
  status                TEXT DEFAULT 'new',         -- new, contacted, interested, thinking, follow_up, not_interested, converted
  notes                 TEXT,
  next_follow_up        DATE,
  last_follow_up        DATE,
  visit_date            DATE DEFAULT CURRENT_DATE,
  converted_student_id  TEXT,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 4. AGENTS (referral agents)
-- ================================================================
CREATE TABLE agents (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id               UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  phone                   TEXT,
  email                   TEXT,
  area                    TEXT,
  company                 TEXT,
  commission_per_student  NUMERIC DEFAULT 0,
  bank_name               TEXT,
  bank_branch             TEXT,
  bank_account            TEXT,
  nid                     TEXT,
  status                  TEXT DEFAULT 'active',    -- active, inactive
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT now()
);

-- Add FK from visitors to agents
ALTER TABLE visitors ADD CONSTRAINT visitors_agent_id_fk FOREIGN KEY (agent_id) REFERENCES agents(id);

-- ================================================================
-- 5. SCHOOLS
-- ================================================================
CREATE TABLE schools (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id         UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name_en           TEXT NOT NULL,
  name_jp           TEXT,
  country           TEXT DEFAULT 'Japan',
  city              TEXT,
  prefecture        TEXT,
  postal_code       TEXT,
  address           TEXT,
  contact_person    TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  website           TEXT,
  shoukai_fee       NUMERIC DEFAULT 0,              -- JPY
  tuition_y1        NUMERIC DEFAULT 0,              -- JPY
  tuition_y2        NUMERIC DEFAULT 0,
  admission_fee     NUMERIC DEFAULT 0,
  facility_fee      NUMERIC DEFAULT 0,
  min_jp_level      TEXT,                            -- N5, N4, etc.
  interview_type    TEXT,                            -- online, in-person, none
  has_dormitory     BOOLEAN DEFAULT false,
  dormitory_fee     NUMERIC DEFAULT 0,
  deadline_april    DATE,
  deadline_october  DATE,
  capacity          INT,
  commission_rate   NUMERIC DEFAULT 0,
  status            TEXT DEFAULT 'active',
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 6. BATCHES (language courses)
-- ================================================================
CREATE TABLE batches (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                        -- "Batch April 2026"
  country     TEXT DEFAULT 'Japan',
  language    TEXT DEFAULT 'Japanese',
  level       TEXT,                                 -- Beginner, N5, N4
  start_date  DATE,
  end_date    DATE,
  capacity    INT DEFAULT 30,
  schedule    TEXT,                                  -- "Sun-Thu, 10AM-12PM"
  teacher     TEXT,
  branch      TEXT,
  status      TEXT DEFAULT 'active',                -- upcoming, active, completed
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 7. STUDENTS (main entity — 45+ fields)
-- ================================================================
CREATE TABLE students (
  id                  TEXT PRIMARY KEY,              -- "S-2026-001"
  agency_id           UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  -- Personal
  name_en             TEXT NOT NULL,
  name_bn             TEXT,
  name_katakana       TEXT,                          -- for Japan visa forms
  phone               TEXT NOT NULL,
  whatsapp            TEXT,
  email               TEXT,
  dob                 DATE,
  gender              TEXT,
  marital_status      TEXT DEFAULT 'Single',
  nationality         TEXT DEFAULT 'Bangladeshi',
  blood_group         TEXT,
  nid                 TEXT,                          -- encrypted at app layer
  -- Passport
  passport_number     TEXT,                          -- encrypted at app layer
  passport_issue      DATE,
  passport_expiry     DATE,
  -- Address
  permanent_address   TEXT,                          -- encrypted at app layer
  current_address     TEXT,
  -- Family (quick reference)
  father_name         TEXT,                          -- encrypted at app layer
  father_name_en      TEXT,
  mother_name         TEXT,                          -- encrypted at app layer
  mother_name_en      TEXT,
  -- Pipeline
  status              TEXT NOT NULL DEFAULT 'VISITOR',
  -- Valid: VISITOR, FOLLOW_UP, ENROLLED, IN_COURSE, EXAM_PASSED,
  --        DOC_COLLECTION, SCHOOL_INTERVIEW, DOC_SUBMITTED,
  --        COE_RECEIVED, VISA_APPLIED, VISA_GRANTED,
  --        TICKET_BOOKED, PRE_DEPARTURE, ARRIVED,
  --        COMPLETED, CANCELLED, PAUSED, REFUNDED,
  --        TRANSFERRED, ON_HOLD
  -- Destination
  country             TEXT DEFAULT 'Japan',
  school_id           UUID REFERENCES schools(id),
  batch_id            UUID REFERENCES batches(id),
  intake              TEXT,                          -- "April 2026"
  visa_type           TEXT,
  -- Source
  source              TEXT,
  agent_id            UUID REFERENCES agents(id),
  referral_info       TEXT,
  student_type        TEXT DEFAULT 'own',            -- own, agent, partner
  counselor           TEXT,
  branch              TEXT,
  -- Files
  gdrive_folder_url   TEXT,
  photo_url           TEXT,
  -- Notes
  internal_notes      TEXT,
  -- Metadata
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 8. STUDENT_EDUCATION
-- ================================================================
CREATE TABLE student_education (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level         TEXT NOT NULL,                      -- SSC, HSC, Honours, Masters, Diploma
  school_name   TEXT,
  year          TEXT,
  board         TEXT,
  gpa           TEXT,
  subject_group TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 9. STUDENT_JP_EXAMS
-- ================================================================
CREATE TABLE student_jp_exams (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_type   TEXT NOT NULL,                        -- JLPT, NAT, JFT, J-TEST, JLCT, TopJ
  level       TEXT,                                 -- N5, N4, N3, N2, N1
  exam_date   DATE,
  score       TEXT,
  result      TEXT,                                 -- pass, fail, pending
  certificate_url TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 10. STUDENT_FAMILY
-- ================================================================
CREATE TABLE student_family (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,                        -- father, mother, spouse, sibling, guardian
  name        TEXT NOT NULL,
  name_en     TEXT,
  dob         DATE,
  nationality TEXT DEFAULT 'Bangladeshi',
  occupation  TEXT,
  workplace   TEXT,
  address     TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 11. SPONSORS
-- ================================================================
CREATE TABLE sponsors (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id          TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  name_en             TEXT,
  relationship        TEXT,                          -- father, mother, uncle, etc.
  phone               TEXT,
  address             TEXT,                          -- encrypted
  nid                 TEXT,                          -- encrypted
  -- Company info
  company_name        TEXT,
  company_address     TEXT,
  trade_license       TEXT,
  tin                 TEXT,
  -- Income (3 years)
  annual_income_y1    NUMERIC,
  annual_income_y2    NUMERIC,
  annual_income_y3    NUMERIC,
  tax_y1              NUMERIC,
  tax_y2              NUMERIC,
  tax_y3              NUMERIC,
  -- Expenses plan
  tuition_jpy         NUMERIC,                       -- total tuition in JPY
  living_jpy_monthly  NUMERIC,                       -- monthly living in JPY
  payment_method      TEXT,                           -- bank_transfer, agency_transfer
  exchange_rate       NUMERIC,
  -- Fund formation
  fund_formation      JSONB DEFAULT '[]'::jsonb,      -- [{ source, amount, proof_doc }]
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(student_id)                                  -- one sponsor per student
);

-- ================================================================
-- 12. SPONSOR_BANKS
-- ================================================================
CREATE TABLE sponsor_banks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sponsor_id          UUID NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  bank_name           TEXT NOT NULL,
  branch              TEXT,
  account_no          TEXT,                           -- encrypted
  balance             NUMERIC,                        -- encrypted at app layer
  balance_date        DATE,
  name_in_statement   TEXT,
  addr_in_statement   TEXT,
  name_in_solvency    TEXT,
  addr_in_solvency    TEXT,
  solvency_url        TEXT,
  statement_url       TEXT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 13. DOCUMENTS
-- ================================================================
CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id      TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  agency_id       UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL,                     -- passport, nid, ssc_cert, hsc_cert, bank_statement, photo, family_register, etc.
  label           TEXT,
  status          TEXT DEFAULT 'pending',             -- pending, collected, submitted, verified, issue, expired
  upload_date     DATE DEFAULT CURRENT_DATE,
  gdrive_url      TEXT,
  file_url        TEXT,                               -- Supabase storage path
  extracted_data  JSONB DEFAULT '{}'::jsonb,           -- { name_en: "...", father_en: "...", dob: "..." }
  notes           TEXT,
  verified_by     UUID REFERENCES users(id),
  verified_at     TIMESTAMPTZ,
  expiry_date     DATE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 14. DOCUMENT_FIELDS (for cross-validation)
-- ================================================================
CREATE TABLE document_fields (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL,                       -- name_en, father_en, dob, address, etc.
  field_value   TEXT,                                -- may be encrypted for sensitive fields
  UNIQUE(document_id, field_name)
);

-- ================================================================
-- 15. SCHOOL_SUBMISSIONS
-- ================================================================
CREATE TABLE submissions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id         UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  school_id         UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  submission_number TEXT,
  intake             TEXT,                            -- April 2026, October 2026
  status             TEXT DEFAULT 'pending',           -- pending, accepted, rejected, interview, waitlisted
  submission_date    DATE DEFAULT CURRENT_DATE,
  result_date        DATE,
  interview_date     DATE,
  interview_notes    TEXT,
  coe_received_date  DATE,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 16. BATCH_STUDENTS (enrollment)
-- ================================================================
CREATE TABLE batch_students (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  status      TEXT DEFAULT 'active',                 -- active, dropped, completed
  UNIQUE(batch_id, student_id)
);

-- ================================================================
-- 17. ATTENDANCE
-- ================================================================
CREATE TABLE attendance (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  batch_id    UUID REFERENCES batches(id),
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'present',       -- present, absent, late
  notes       TEXT,
  marked_by   UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(student_id, date)
);

-- ================================================================
-- 18. PAYMENTS (student fees)
-- ================================================================
CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id         UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  student_id        TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,                   -- enrollment_fee, course_fee, doc_processing, visa_fee, service_charge, shoukai_fee, other
  label             TEXT,
  total_amount      NUMERIC NOT NULL DEFAULT 0,
  tax_amount        NUMERIC DEFAULT 0,
  paid_amount       NUMERIC DEFAULT 0,
  installments      INT DEFAULT 1,
  paid_installments INT DEFAULT 0,
  payment_method    TEXT DEFAULT 'Cash',             -- Cash, Bank Transfer, bKash, Nagad, Cheque
  due_date          DATE,
  status            TEXT DEFAULT 'pending',          -- pending, partial, paid, overdue, refunded
  receipt_no        TEXT,
  received_by       UUID REFERENCES users(id),
  notes             TEXT,
  date              DATE DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 19. PAYMENT_INSTALLMENTS (individual payment records)
-- ================================================================
CREATE TABLE payment_installments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL,
  method      TEXT DEFAULT 'Cash',
  date        DATE DEFAULT CURRENT_DATE,
  receipt_no  TEXT,
  received_by UUID REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 20. EXPENSES
-- ================================================================
CREATE TABLE expenses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,                         -- rent, salary, utility, marketing, supplies, travel, other
  description TEXT,
  amount      NUMERIC NOT NULL,
  date        DATE DEFAULT CURRENT_DATE,
  branch      TEXT,
  paid_by     TEXT,
  receipt_url TEXT,
  approved_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 21. EMPLOYEES
-- ================================================================
CREATE TABLE employees (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  name        TEXT NOT NULL,
  designation TEXT,
  department  TEXT,
  phone       TEXT,
  email       TEXT,
  salary      NUMERIC,
  branch      TEXT,
  join_date   DATE,
  status      TEXT DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 22. SALARY_HISTORY
-- ================================================================
CREATE TABLE salary_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,                         -- "2026-03"
  amount      NUMERIC NOT NULL,
  method      TEXT DEFAULT 'Bank Transfer',
  paid_date   DATE DEFAULT CURRENT_DATE,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 23. TASKS
-- ================================================================
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  priority      TEXT DEFAULT 'medium',               -- low, medium, high, urgent
  status        TEXT DEFAULT 'pending',               -- pending, in_progress, completed, cancelled
  assignee_id   UUID REFERENCES users(id),
  student_id    TEXT REFERENCES students(id),
  due_date      DATE,
  completed_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 24. COMMUNICATIONS
-- ================================================================
CREATE TABLE communications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id       UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  student_id      TEXT REFERENCES students(id),
  visitor_id      UUID REFERENCES visitors(id),
  type            TEXT NOT NULL,                     -- call, sms, email, whatsapp, meeting, viber
  direction       TEXT DEFAULT 'outgoing',            -- incoming, outgoing
  subject         TEXT,
  notes           TEXT,
  follow_up_date  DATE,
  logged_by       UUID REFERENCES users(id),
  duration_min    INT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 25. CALENDAR_EVENTS
-- ================================================================
CREATE TABLE calendar_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  date        DATE NOT NULL,
  time        TEXT,
  end_time    TEXT,
  type        TEXT DEFAULT 'general',                -- interview, deadline, meeting, exam, class, general
  description TEXT,
  student_id  TEXT REFERENCES students(id),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 26. CLASS_TESTS
-- ================================================================
CREATE TABLE class_tests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  test_name   TEXT NOT NULL,
  date        DATE DEFAULT CURRENT_DATE,
  total_marks INT DEFAULT 100,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE class_test_scores (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  test_id     UUID NOT NULL REFERENCES class_tests(id) ON DELETE CASCADE,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score       INT,
  grade       TEXT,
  remarks     TEXT,
  UNIQUE(test_id, student_id)
);

-- ================================================================
-- 27. EXCEL_TEMPLATES
-- ================================================================
CREATE TABLE excel_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id       UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  school_id       UUID REFERENCES schools(id),
  school_name     TEXT NOT NULL,
  file_name       TEXT,
  template_url    TEXT,                               -- storage path
  version         TEXT DEFAULT '1.0',
  mappings        JSONB DEFAULT '[]'::jsonb,           -- [{ cell, label, field }]
  total_fields    INT DEFAULT 0,
  mapped_fields   INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 28. ACTIVITY_LOG (audit trail)
-- ================================================================
CREATE TABLE activity_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL,                          -- create, update, delete, login, export, status_change
  module      TEXT NOT NULL,                          -- students, visitors, documents, payments, etc.
  record_id   TEXT,
  description TEXT,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ================================================================
-- 29. INVENTORY
-- ================================================================
CREATE TABLE inventory (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT,
  quantity    INT DEFAULT 0,
  unit_price  NUMERIC DEFAULT 0,
  branch      TEXT,
  status      TEXT DEFAULT 'available',
  created_at  TIMESTAMPTZ DEFAULT now()
);
-- ================================================================
-- AgencyOS — Indexes for performance
-- Migration 002
-- ================================================================

-- Agencies
CREATE INDEX idx_agencies_subdomain ON agencies(subdomain);

-- Users
CREATE INDEX idx_users_agency ON users(agency_id);
CREATE INDEX idx_users_auth ON users(auth_user_id);
CREATE INDEX idx_users_email ON users(agency_id, email);

-- Visitors
CREATE INDEX idx_visitors_agency ON visitors(agency_id);
CREATE INDEX idx_visitors_status ON visitors(agency_id, status);
CREATE INDEX idx_visitors_phone ON visitors(phone);
CREATE INDEX idx_visitors_source ON visitors(agency_id, source);
CREATE INDEX idx_visitors_date ON visitors(visit_date);
CREATE INDEX idx_visitors_follow_up ON visitors(next_follow_up) WHERE next_follow_up IS NOT NULL;

-- Agents
CREATE INDEX idx_agents_agency ON agents(agency_id);
CREATE INDEX idx_agents_status ON agents(agency_id, status);

-- Schools
CREATE INDEX idx_schools_agency ON schools(agency_id);
CREATE INDEX idx_schools_country ON schools(agency_id, country);

-- Batches
CREATE INDEX idx_batches_agency ON batches(agency_id);
CREATE INDEX idx_batches_status ON batches(agency_id, status);

-- Students
CREATE INDEX idx_students_agency ON students(agency_id);
CREATE INDEX idx_students_status ON students(agency_id, status);
CREATE INDEX idx_students_country ON students(agency_id, country);
CREATE INDEX idx_students_batch ON students(batch_id);
CREATE INDEX idx_students_school ON students(school_id);
CREATE INDEX idx_students_agent ON students(agent_id);
CREATE INDEX idx_students_phone ON students(phone);
CREATE INDEX idx_students_name ON students(agency_id, name_en);

-- Student sub-tables
CREATE INDEX idx_student_education_student ON student_education(student_id);
CREATE INDEX idx_student_jp_exams_student ON student_jp_exams(student_id);
CREATE INDEX idx_student_family_student ON student_family(student_id);

-- Sponsors
CREATE INDEX idx_sponsors_student ON sponsors(student_id);
CREATE INDEX idx_sponsor_banks_sponsor ON sponsor_banks(sponsor_id);

-- Documents
CREATE INDEX idx_documents_student ON documents(student_id);
CREATE INDEX idx_documents_agency ON documents(agency_id);
CREATE INDEX idx_documents_type ON documents(agency_id, doc_type);
CREATE INDEX idx_documents_status ON documents(agency_id, status);
CREATE INDEX idx_document_fields_doc ON document_fields(document_id);

-- Submissions
CREATE INDEX idx_submissions_agency ON submissions(agency_id);
CREATE INDEX idx_submissions_school ON submissions(school_id);
CREATE INDEX idx_submissions_student ON submissions(student_id);

-- Batch Students
CREATE INDEX idx_batch_students_batch ON batch_students(batch_id);
CREATE INDEX idx_batch_students_student ON batch_students(student_id);

-- Attendance
CREATE INDEX idx_attendance_agency ON attendance(agency_id);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_student_date ON attendance(student_id, date);
CREATE INDEX idx_attendance_batch ON attendance(batch_id, date);

-- Payments
CREATE INDEX idx_payments_agency ON payments(agency_id);
CREATE INDEX idx_payments_student ON payments(student_id);
CREATE INDEX idx_payments_status ON payments(agency_id, status);
CREATE INDEX idx_payments_date ON payments(date);
CREATE INDEX idx_payment_installments_payment ON payment_installments(payment_id);

-- Expenses
CREATE INDEX idx_expenses_agency ON expenses(agency_id);
CREATE INDEX idx_expenses_date ON expenses(agency_id, date);

-- Employees & Salary
CREATE INDEX idx_employees_agency ON employees(agency_id);
CREATE INDEX idx_salary_history_employee ON salary_history(employee_id);

-- Tasks
CREATE INDEX idx_tasks_agency ON tasks(agency_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_status ON tasks(agency_id, status);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE status != 'completed';

-- Communications
CREATE INDEX idx_communications_agency ON communications(agency_id);
CREATE INDEX idx_communications_student ON communications(student_id);
CREATE INDEX idx_communications_visitor ON communications(visitor_id);

-- Calendar
CREATE INDEX idx_calendar_agency ON calendar_events(agency_id);
CREATE INDEX idx_calendar_date ON calendar_events(agency_id, date);

-- Class Tests
CREATE INDEX idx_class_tests_batch ON class_tests(batch_id);
CREATE INDEX idx_class_test_scores_test ON class_test_scores(test_id);
CREATE INDEX idx_class_test_scores_student ON class_test_scores(student_id);

-- Activity Log
CREATE INDEX idx_activity_log_agency ON activity_log(agency_id);
CREATE INDEX idx_activity_log_user ON activity_log(user_id);
CREATE INDEX idx_activity_log_module ON activity_log(agency_id, module);
CREATE INDEX idx_activity_log_date ON activity_log(created_at);

-- Excel Templates
CREATE INDEX idx_excel_templates_agency ON excel_templates(agency_id);

-- Inventory
CREATE INDEX idx_inventory_agency ON inventory(agency_id);
-- ================================================================
-- AgencyOS — Row Level Security (RLS)
-- Migration 003: Multi-tenant isolation by agency_id
-- ================================================================

-- Helper function: get current user's agency_id from JWT
CREATE OR REPLACE FUNCTION current_user_agency_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT agency_id FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Helper function: get current user's role
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Helper function: get current user's id
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- ================================================================
-- Enable RLS on all tables
-- ================================================================
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_education ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_jp_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_family ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_test_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE excel_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;

-- ================================================================
-- AGENCIES — users can only see their own agency
-- ================================================================
CREATE POLICY agencies_select ON agencies FOR SELECT
  USING (id = current_user_agency_id());

CREATE POLICY agencies_update ON agencies FOR UPDATE
  USING (id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- ================================================================
-- USERS — same agency only
-- ================================================================
CREATE POLICY users_select ON users FOR SELECT
  USING (agency_id = current_user_agency_id());

CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

CREATE POLICY users_update ON users FOR UPDATE
  USING (agency_id = current_user_agency_id() AND (id = current_user_id() OR current_user_role() IN ('owner', 'manager')));

CREATE POLICY users_delete ON users FOR DELETE
  USING (agency_id = current_user_agency_id() AND current_user_role() = 'owner');

-- ================================================================
-- Macro: standard agency-scoped CRUD policies
-- We create SELECT/INSERT/UPDATE/DELETE for each table with agency_id
-- ================================================================

-- VISITORS
CREATE POLICY visitors_select ON visitors FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY visitors_insert ON visitors FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY visitors_update ON visitors FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY visitors_delete ON visitors FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- AGENTS
CREATE POLICY agents_select ON agents FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY agents_insert ON agents FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY agents_update ON agents FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY agents_delete ON agents FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- SCHOOLS
CREATE POLICY schools_select ON schools FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY schools_insert ON schools FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY schools_update ON schools FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY schools_delete ON schools FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- BATCHES
CREATE POLICY batches_select ON batches FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY batches_insert ON batches FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY batches_update ON batches FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY batches_delete ON batches FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- STUDENTS
CREATE POLICY students_select ON students FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY students_insert ON students FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY students_update ON students FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY students_delete ON students FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- STUDENT_EDUCATION (via student's agency)
CREATE POLICY student_education_select ON student_education FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_insert ON student_education FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_update ON student_education FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_delete ON student_education FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- STUDENT_JP_EXAMS
CREATE POLICY student_jp_exams_select ON student_jp_exams FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_insert ON student_jp_exams FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_update ON student_jp_exams FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_delete ON student_jp_exams FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- STUDENT_FAMILY
CREATE POLICY student_family_select ON student_family FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_insert ON student_family FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_update ON student_family FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_delete ON student_family FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- SPONSORS
CREATE POLICY sponsors_select ON sponsors FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_insert ON sponsors FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_update ON sponsors FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_delete ON sponsors FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- SPONSOR_BANKS (via sponsor → student)
CREATE POLICY sponsor_banks_select ON sponsor_banks FOR SELECT
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_insert ON sponsor_banks FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_update ON sponsor_banks FOR UPDATE
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_delete ON sponsor_banks FOR DELETE
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));

-- DOCUMENTS
CREATE POLICY documents_select ON documents FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY documents_update ON documents FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY documents_delete ON documents FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- DOCUMENT_FIELDS (via document's agency)
CREATE POLICY document_fields_select ON document_fields FOR SELECT
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_insert ON document_fields FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_update ON document_fields FOR UPDATE
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_delete ON document_fields FOR DELETE
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));

-- SUBMISSIONS
CREATE POLICY submissions_select ON submissions FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY submissions_insert ON submissions FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY submissions_update ON submissions FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY submissions_delete ON submissions FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- BATCH_STUDENTS (via batch's agency)
CREATE POLICY batch_students_select ON batch_students FOR SELECT
  USING (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));
CREATE POLICY batch_students_insert ON batch_students FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));
CREATE POLICY batch_students_delete ON batch_students FOR DELETE
  USING (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));

-- ATTENDANCE
CREATE POLICY attendance_select ON attendance FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY attendance_insert ON attendance FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY attendance_update ON attendance FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY attendance_delete ON attendance FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- PAYMENTS
CREATE POLICY payments_select ON payments FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY payments_update ON payments FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY payments_delete ON payments FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- PAYMENT_INSTALLMENTS (via payment's agency)
CREATE POLICY payment_installments_select ON payment_installments FOR SELECT
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));
CREATE POLICY payment_installments_insert ON payment_installments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));
CREATE POLICY payment_installments_delete ON payment_installments FOR DELETE
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));

-- EXPENSES
CREATE POLICY expenses_select ON expenses FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY expenses_insert ON expenses FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY expenses_update ON expenses FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY expenses_delete ON expenses FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- EMPLOYEES
CREATE POLICY employees_select ON employees FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY employees_insert ON employees FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY employees_update ON employees FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY employees_delete ON employees FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() = 'owner');

-- SALARY_HISTORY (via employee's agency)
CREATE POLICY salary_history_select ON salary_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.agency_id = current_user_agency_id()));
CREATE POLICY salary_history_insert ON salary_history FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.agency_id = current_user_agency_id()));

-- TASKS
CREATE POLICY tasks_select ON tasks FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY tasks_delete ON tasks FOR DELETE USING (agency_id = current_user_agency_id());

-- COMMUNICATIONS
CREATE POLICY comms_select ON communications FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY comms_insert ON communications FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY comms_update ON communications FOR UPDATE USING (agency_id = current_user_agency_id());

-- CALENDAR_EVENTS
CREATE POLICY calendar_select ON calendar_events FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY calendar_insert ON calendar_events FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY calendar_update ON calendar_events FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY calendar_delete ON calendar_events FOR DELETE USING (agency_id = current_user_agency_id());

-- CLASS_TESTS
CREATE POLICY class_tests_select ON class_tests FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY class_tests_insert ON class_tests FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY class_tests_update ON class_tests FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY class_tests_delete ON class_tests FOR DELETE USING (agency_id = current_user_agency_id());

-- CLASS_TEST_SCORES (via test's agency)
CREATE POLICY class_test_scores_select ON class_test_scores FOR SELECT
  USING (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));
CREATE POLICY class_test_scores_insert ON class_test_scores FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));
CREATE POLICY class_test_scores_update ON class_test_scores FOR UPDATE
  USING (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));

-- EXCEL_TEMPLATES
CREATE POLICY excel_templates_select ON excel_templates FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_insert ON excel_templates FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_update ON excel_templates FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_delete ON excel_templates FOR DELETE USING (agency_id = current_user_agency_id());

-- ACTIVITY_LOG
CREATE POLICY activity_log_select ON activity_log FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY activity_log_insert ON activity_log FOR INSERT WITH CHECK (agency_id = current_user_agency_id());

-- INVENTORY
CREATE POLICY inventory_select ON inventory FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY inventory_insert ON inventory FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY inventory_update ON inventory FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY inventory_delete ON inventory FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));
-- ================================================================
-- AgencyOS — Storage Buckets with RLS
-- Migration 004
-- ================================================================

-- Create storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES
  ('templates', 'templates', false),       -- Excel school forms
  ('documents', 'documents', false),       -- Student documents (passport, NID, certs)
  ('generated', 'generated', false),       -- Auto-filled output files
  ('photos', 'photos', true);             -- Student photos (public for display)

-- ================================================================
-- Storage RLS: agency_id folder isolation
-- File paths follow: {agency_id}/{student_id}/{filename}
-- ================================================================

-- TEMPLATES bucket
CREATE POLICY templates_select ON storage.objects FOR SELECT
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY templates_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'templates' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- DOCUMENTS bucket
CREATE POLICY documents_storage_select ON storage.objects FOR SELECT
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY documents_storage_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- GENERATED bucket
CREATE POLICY generated_select ON storage.objects FOR SELECT
  USING (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY generated_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY generated_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'generated' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

-- PHOTOS bucket (public read, agency-scoped write)
CREATE POLICY photos_select ON storage.objects FOR SELECT
  USING (bucket_id = 'photos');  -- public read

CREATE POLICY photos_insert ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY photos_update ON storage.objects FOR UPDATE
  USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);

CREATE POLICY photos_delete ON storage.objects FOR DELETE
  USING (bucket_id = 'photos' AND (storage.foldername(name))[1] = current_user_agency_id()::text);
-- ================================================================
-- AgencyOS — Auth Setup
-- Migration 005: triggers to sync auth.users with public.users
-- ================================================================

-- Function: on new auth signup, create or link user record
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agency_id UUID;
  v_role TEXT;
  v_name TEXT;
BEGIN
  -- Check if user was invited (agency_id in metadata)
  v_agency_id := (NEW.raw_user_meta_data->>'agency_id')::UUID;
  v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'counselor');
  v_name := COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1));

  IF v_agency_id IS NOT NULL THEN
    -- Invited user: create user record under existing agency
    INSERT INTO users (auth_user_id, agency_id, name, email, role, branch)
    VALUES (NEW.id, v_agency_id, v_name, NEW.email, v_role, 'Main')
    ON CONFLICT (auth_user_id) DO UPDATE SET email = NEW.email;
  ELSE
    -- New agency signup: create agency + owner user
    INSERT INTO agencies (subdomain, name, email)
    VALUES (
      LOWER(REPLACE(split_part(NEW.email, '@', 1), '.', '-')) || '-' || SUBSTRING(NEW.id::text, 1, 4),
      v_name || '''s Agency',
      NEW.email
    )
    RETURNING id INTO v_agency_id;

    INSERT INTO users (auth_user_id, agency_id, name, email, role, branch)
    VALUES (NEW.id, v_agency_id, v_name, NEW.email, 'owner', 'Main');
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger: fire on new auth user
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Function: on auth user delete, deactivate (not hard delete)
CREATE OR REPLACE FUNCTION handle_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users SET is_active = false WHERE auth_user_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER on_auth_user_deleted
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_user_delete();

-- Function: updated_at auto-trigger for any table
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Apply updated_at trigger to tables that have the column
CREATE TRIGGER set_agencies_updated_at BEFORE UPDATE ON agencies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_visitors_updated_at BEFORE UPDATE ON visitors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_sponsors_updated_at BEFORE UPDATE ON sponsors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_documents_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- ================================================================
-- AgencyOS — Seed Data (demo agency)
-- Migration 006
-- Run AFTER auth setup. Adjust auth_user_id after first login.
-- ================================================================

-- Create demo agency
INSERT INTO agencies (id, subdomain, name, name_bn, phone, email, status, plan) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'demo-agency', 'Demo Education Agency', 'ডেমো এডুকেশন এজেন্সি', '01700000000', 'admin@agencyos.com', 'active', 'pro');

-- Create admin user (auth_user_id will be linked after first Supabase Auth login)
INSERT INTO users (id, agency_id, name, email, role, branch, is_active) VALUES
  ('u0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Admin', 'admin@agencyos.com', 'owner', 'Main', true);

-- Sample agents
INSERT INTO agents (agency_id, name, phone, area, commission_per_student, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Hafizur Rahman', '01712340010', 'Comilla', 10000, 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Abdur Rahim', '01812340020', 'Sylhet', 8000, 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Kamrul Hasan', '01912340030', 'Dhaka', 12000, 'active');

-- Sample schools
INSERT INTO schools (agency_id, name_en, name_jp, country, city, tuition_y1, min_jp_level, interview_type, has_dormitory) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Tokyo Galaxy Japanese School', '東京ギャラクシー日本語学校', 'Japan', 'Tokyo', 780000, 'N5', 'online', true),
  ('a0000000-0000-0000-0000-000000000001', 'Osaka Minami Japanese School', '大阪みなみ日本語学校', 'Japan', 'Osaka', 720000, 'N5', 'online', false),
  ('a0000000-0000-0000-0000-000000000001', 'ISI Language School', 'ISI日本語学校', 'Japan', 'Tokyo', 850000, 'N4', 'in-person', true);

-- Sample batches
INSERT INTO batches (agency_id, name, level, start_date, end_date, capacity, schedule, teacher, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Batch April 2026', 'N5', '2025-12-01', '2026-03-31', 25, 'Sun-Thu 10AM-12PM', 'Sensei Tanaka', 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Batch October 2026', 'N5', '2026-04-01', '2026-09-30', 30, 'Sun-Thu 2PM-4PM', 'Sensei Yamada', 'upcoming');
