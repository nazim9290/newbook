-- AgencyBook SaaS — Full PostgreSQL Schema
-- সব table CREATE IF NOT EXISTS দিয়ে — safe to re-run

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS agencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subdomain TEXT UNIQUE NOT NULL, name TEXT NOT NULL, name_bn TEXT,
  prefix TEXT UNIQUE,  -- Agency ID prefix (SEC, DLA, ABI etc.) — সব entity ID-তে ব্যবহার হবে
  id_counters JSONB DEFAULT '{"student":0,"visitor":0,"payment":0,"invoice":0,"submission":0}',
  phone TEXT, email TEXT, trade_license TEXT, tin TEXT, logo_url TEXT, address TEXT,
  settings JSONB DEFAULT '{}', status TEXT DEFAULT 'active', plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

-- Existing agencies-এ prefix column যোগ (safe — already exists হলে skip)
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS prefix TEXT UNIQUE;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS id_counters JSONB DEFAULT '{"student":0,"visitor":0,"payment":0,"invoice":0,"submission":0}';

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  auth_user_id UUID UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT,
  phone TEXT, role TEXT DEFAULT 'counselor', branch TEXT DEFAULT 'Main',
  permissions JSONB DEFAULT '{}', avatar_url TEXT, is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agency_id, email)
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT, email TEXT, area TEXT, company TEXT,
  commission_per_student NUMERIC DEFAULT 0, bank_name TEXT, bank_branch TEXT,
  bank_account TEXT, nid TEXT, status TEXT DEFAULT 'active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visitors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  display_id TEXT,  -- Agency prefix visitor ID (SEC-V-2026-001)
  name TEXT, name_en TEXT, name_bn TEXT, phone TEXT NOT NULL, guardian_phone TEXT,
  email TEXT, dob DATE, gender TEXT, blood_group TEXT, address TEXT,
  education JSONB DEFAULT '[]',
  has_jp_cert BOOLEAN DEFAULT false, jp_exam_type TEXT, jp_exam_type_other TEXT,
  jp_level TEXT, jp_score TEXT, visa_type TEXT, visa_type_other TEXT,
  interested_countries TEXT[] DEFAULT '{Japan}', interested_intake TEXT,
  budget_concern BOOLEAN DEFAULT false,
  source TEXT DEFAULT 'Walk-in', agent_id UUID REFERENCES agents(id), agent_name TEXT,
  referral_info TEXT, counselor TEXT, branch TEXT,
  status TEXT DEFAULT 'Interested', notes TEXT,
  next_follow_up DATE, last_follow_up DATE, visit_date DATE DEFAULT CURRENT_DATE,
  converted_student_id TEXT, created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL, name_jp TEXT, country TEXT DEFAULT 'Japan',
  city TEXT, prefecture TEXT, postal_code TEXT, address TEXT,
  contact_person TEXT, contact_email TEXT, contact_phone TEXT, website TEXT,
  shoukai_fee NUMERIC DEFAULT 0, tuition_y1 NUMERIC DEFAULT 0, tuition_y2 NUMERIC DEFAULT 0,
  admission_fee NUMERIC DEFAULT 0, facility_fee NUMERIC DEFAULT 0, min_jp_level TEXT,
  interview_type TEXT, has_dormitory BOOLEAN DEFAULT false, dormitory_fee NUMERIC DEFAULT 0,
  deadline_april DATE, deadline_october DATE, capacity INT,
  commission_rate NUMERIC DEFAULT 0, status TEXT DEFAULT 'active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, country TEXT DEFAULT 'Japan', language TEXT DEFAULT 'Japanese',
  level TEXT, start_date DATE, end_date DATE, capacity INT DEFAULT 30,
  schedule TEXT, teacher TEXT, branch TEXT, status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL, name_bn TEXT, name_katakana TEXT,
  phone TEXT NOT NULL, whatsapp TEXT, email TEXT,
  dob DATE, gender TEXT, marital_status TEXT DEFAULT 'Single',
  nationality TEXT DEFAULT 'Bangladeshi', blood_group TEXT,
  nid TEXT, passport_number TEXT, passport_issue DATE, passport_expiry DATE,
  permanent_address TEXT, current_address TEXT,
  father_name TEXT, father_name_en TEXT, mother_name TEXT, mother_name_en TEXT,
  status TEXT NOT NULL DEFAULT 'ENROLLED',
  country TEXT DEFAULT 'Japan',
  school_id UUID REFERENCES schools(id), batch_id UUID REFERENCES batches(id),
  school TEXT, batch TEXT, intake TEXT, visa_type TEXT,
  source TEXT, agent_id UUID REFERENCES agents(id), referral_info TEXT,
  student_type TEXT DEFAULT 'own', type TEXT DEFAULT 'own',
  counselor TEXT, branch TEXT,
  gdrive_folder_url TEXT, photo_url TEXT, internal_notes TEXT,
  created_by UUID, created TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_education (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, level TEXT, school_name TEXT, year TEXT, board TEXT, gpa TEXT, subject_group TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS student_jp_exams (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, exam_type TEXT, level TEXT, exam_date DATE, score TEXT, result TEXT, certificate_url TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS student_family (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, relation TEXT, name TEXT, name_en TEXT, dob DATE, nationality TEXT, occupation TEXT, workplace TEXT, address TEXT, phone TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS sponsors (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, name TEXT, name_en TEXT, relationship TEXT, phone TEXT, address TEXT, nid TEXT, company_name TEXT, company_address TEXT, trade_license TEXT, tin TEXT, annual_income_y1 NUMERIC, annual_income_y2 NUMERIC, annual_income_y3 NUMERIC, tax_y1 NUMERIC, tax_y2 NUMERIC, tax_y3 NUMERIC, tuition_jpy NUMERIC, living_jpy_monthly NUMERIC, payment_method TEXT, exchange_rate NUMERIC, fund_formation JSONB DEFAULT '[]', notes TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(student_id));
CREATE TABLE IF NOT EXISTS sponsor_banks (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), sponsor_id UUID REFERENCES sponsors(id) ON DELETE CASCADE, bank_name TEXT, branch TEXT, account_no TEXT, balance NUMERIC, balance_date DATE, name_in_statement TEXT, addr_in_statement TEXT, name_in_solvency TEXT, addr_in_solvency TEXT, solvency_url TEXT, statement_url TEXT, created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS documents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, agency_id UUID REFERENCES agencies(id), doc_type TEXT, label TEXT, status TEXT DEFAULT 'pending', upload_date DATE DEFAULT CURRENT_DATE, gdrive_url TEXT, file_url TEXT, extracted_data JSONB DEFAULT '{}', notes TEXT, verified_by UUID, verified_at TIMESTAMPTZ, expiry_date DATE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS document_fields (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), document_id UUID REFERENCES documents(id) ON DELETE CASCADE, field_name TEXT NOT NULL, field_value TEXT, UNIQUE(document_id, field_name));

CREATE TABLE IF NOT EXISTS submissions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), school_id UUID REFERENCES schools(id) ON DELETE CASCADE, student_id TEXT REFERENCES students(id) ON DELETE CASCADE, submission_number TEXT, intake TEXT, status TEXT DEFAULT 'pending', submission_date DATE DEFAULT CURRENT_DATE, result_date DATE, interview_date DATE, interview_notes TEXT, feedback TEXT, recheck_count INT DEFAULT 0, coe_received_date DATE, notes TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS batch_students (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), batch_id UUID REFERENCES batches(id) ON DELETE CASCADE, student_id TEXT REFERENCES students(id) ON DELETE CASCADE, enrolled_at TIMESTAMPTZ DEFAULT now(), status TEXT DEFAULT 'active', UNIQUE(batch_id, student_id));
CREATE TABLE IF NOT EXISTS attendance (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), batch_id UUID REFERENCES batches(id), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, date DATE NOT NULL, status TEXT DEFAULT 'present', notes TEXT, marked_by UUID, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(student_id, date));

CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, category TEXT, label TEXT, amount NUMERIC DEFAULT 0, total_amount NUMERIC DEFAULT 0, tax_amount NUMERIC DEFAULT 0, paid_amount NUMERIC DEFAULT 0, installments INT DEFAULT 1, paid_installments INT DEFAULT 0, payment_method TEXT DEFAULT 'Cash', method TEXT DEFAULT 'Cash', due_date DATE, status TEXT DEFAULT 'pending', receipt_no TEXT, received_by UUID, notes TEXT, note TEXT, date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS fee_items (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, category TEXT NOT NULL, label TEXT NOT NULL, amount NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS expenses (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), category TEXT NOT NULL, description TEXT, amount NUMERIC NOT NULL, date DATE DEFAULT CURRENT_DATE, branch TEXT, paid_by TEXT, receipt_url TEXT, approved_by UUID, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS employees (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), user_id UUID, name TEXT NOT NULL, designation TEXT, role TEXT, department TEXT, phone TEXT, email TEXT, salary NUMERIC, branch TEXT, join_date DATE, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS salary_history (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), employee_id UUID REFERENCES employees(id) ON DELETE CASCADE, month TEXT NOT NULL, amount NUMERIC NOT NULL, method TEXT DEFAULT 'Bank Transfer', paid_date DATE DEFAULT CURRENT_DATE, note TEXT, paid BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), title TEXT NOT NULL, description TEXT, priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'pending', assignee_id UUID, student_id TEXT REFERENCES students(id), due_date DATE, completed_at TIMESTAMPTZ, created_by UUID, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS communications (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), student_id TEXT REFERENCES students(id), visitor_id UUID, type TEXT NOT NULL, direction TEXT DEFAULT 'outgoing', subject TEXT, notes TEXT, content TEXT, follow_up_date DATE, logged_by UUID, duration_min INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS calendar_events (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), title TEXT NOT NULL, date DATE NOT NULL, time TEXT, end_time TEXT, type TEXT DEFAULT 'general', description TEXT, student_id TEXT REFERENCES students(id), created_by UUID, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT, quantity INT DEFAULT 0,
  unit_price NUMERIC DEFAULT 0, branch TEXT,
  condition TEXT DEFAULT 'new', status TEXT DEFAULT 'new',
  brand TEXT, model TEXT, vendor TEXT, location TEXT,
  purchase_date DATE, warranty TEXT, assigned_to TEXT, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS excel_templates (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), school_id UUID REFERENCES schools(id), school_name TEXT, file_name TEXT, template_url TEXT, version TEXT DEFAULT '1.0', mappings JSONB DEFAULT '[]', total_fields INT DEFAULT 0, mapped_fields INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS doc_templates (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), name TEXT NOT NULL, description TEXT, template_url TEXT, linked_doc_type TEXT, field_mappings JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS doc_types (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), name TEXT NOT NULL, name_bn TEXT, category TEXT DEFAULT 'personal', fields JSONB DEFAULT '[]', is_active BOOLEAN DEFAULT true, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS document_data (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), student_id TEXT REFERENCES students(id) ON DELETE CASCADE, doc_type_id UUID REFERENCES doc_types(id) ON DELETE CASCADE, field_data JSONB DEFAULT '{}', status TEXT DEFAULT 'incomplete', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(student_id, doc_type_id));
CREATE TABLE IF NOT EXISTS activity_log (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agency_id UUID REFERENCES agencies(id), user_id UUID, action TEXT, module TEXT, record_id TEXT, description TEXT, old_value JSONB, new_value JSONB, ip_address TEXT, created_at TIMESTAMPTZ DEFAULT now());

-- Branches — এজেন্সির শাখা (ঠিকানা, ফোন, ম্যানেজার সহ)
CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, name_bn TEXT, city TEXT,
  address TEXT, address_bn TEXT, phone TEXT, email TEXT,
  manager TEXT, is_hq BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agency_id, name)
);

-- Partner Agencies (B2B) — অন্য এজেন্সি থেকে আসা student tracking
CREATE TABLE IF NOT EXISTS partner_agencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, address TEXT,
  services TEXT[] DEFAULT '{}', commission_rate NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS partner_students (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id UUID REFERENCES partner_agencies(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
  student_name TEXT, fee NUMERIC DEFAULT 0, paid NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

-- Pre-Departure tracking — COE থেকে arrival পর্যন্ত checklist
CREATE TABLE IF NOT EXISTS pre_departure (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  coe_number TEXT, coe_date DATE,
  health_status TEXT DEFAULT 'pending', health_date DATE, health_notes TEXT,
  tuition_amount NUMERIC DEFAULT 0, tuition_remitted BOOLEAN DEFAULT false, tuition_date DATE,
  vfs_appointment_date DATE, vfs_docs_submitted BOOLEAN DEFAULT false,
  visa_status TEXT DEFAULT 'pending', visa_date DATE, visa_expiry DATE,
  flight_date DATE, flight_number TEXT, arrival_confirmed BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(student_id)
);

-- Seed default agency + admin
INSERT INTO agencies (id, subdomain, name, name_bn, plan, status) VALUES ('a0000000-0000-0000-0000-000000000001', 'demo', 'AgencyBook Demo', 'AgencyBook ডেমো', 'pro', 'active') ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, agency_id, name, email, password_hash, role, branch) VALUES ('u0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Admin', 'admin@agencybook.net', '$2a$10$XQxBj0JM6x/HxmHLkZPfCOK5bCGPGMlbSIlWMvfzNCwEd.JWjKF5i', 'owner', 'Main') ON CONFLICT DO NOTHING;
