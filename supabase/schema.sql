-- ================================================
-- AgencyOS — Supabase Database Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL)
-- ================================================

-- 1. Users (staff accounts)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'counselor',     -- owner, branch_manager, counselor, accountant, viewer
  branch TEXT DEFAULT 'ঢাকা',
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Students (main entity)
CREATE TABLE students (
  id TEXT PRIMARY KEY,                        -- e.g. "STU-001"
  name_en TEXT NOT NULL,
  name_bn TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  gender TEXT,
  dob DATE,
  blood_group TEXT,
  nid TEXT,
  passport_number TEXT,
  passport_expiry DATE,
  present_address TEXT,
  permanent_address TEXT,
  country TEXT DEFAULT 'Japan',               -- Japan, Germany, etc.
  school TEXT,
  batch TEXT,
  branch TEXT DEFAULT 'ঢাকা',
  source TEXT,                                -- Facebook, Referral, Walk-in, etc.
  status TEXT NOT NULL DEFAULT 'VISITOR',     -- pipeline status
  photo_url TEXT,
  agent_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Student Education History
CREATE TABLE education (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  degree TEXT NOT NULL,                       -- SSC, HSC, Honours, Masters
  institution TEXT,
  board TEXT,
  passing_year TEXT,
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Student Employment History
CREATE TABLE employment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  designation TEXT,
  duration TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Japanese Language Study History
CREATE TABLE jp_study (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  institution TEXT NOT NULL,
  level TEXT,
  duration TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Japanese Language Exam Results
CREATE TABLE jp_exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  exam_name TEXT NOT NULL,                    -- JLPT, NAT, J-TEST
  level TEXT,
  score TEXT,
  result TEXT,                                -- pass, fail
  exam_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Sponsor Info
CREATE TABLE sponsor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  name_en TEXT,
  name_bn TEXT,
  relationship TEXT,
  phone TEXT,
  occupation TEXT,
  annual_income NUMERIC,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Sponsor Bank Accounts
CREATE TABLE sponsor_banks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id UUID REFERENCES sponsor(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_number TEXT,
  balance NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. Fee Items (fee breakdown per student)
CREATE TABLE fee_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  category TEXT NOT NULL,                     -- enrollment_fee, course_fee, doc_processing, visa_fee, service_charge, shokai_fee, other_income
  label TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 10. Payments (actual collections)
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  category TEXT,
  method TEXT DEFAULT 'Cash',                 -- Cash, Bank Transfer, bKash, Cheque
  date DATE DEFAULT CURRENT_DATE,
  note TEXT,
  received_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 11. Visitors (lead tracking)
CREATE TABLE visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en TEXT NOT NULL,
  name_bn TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  source TEXT,                                -- Facebook, Referral, Walk-in, Agent
  interest TEXT,                              -- Japan, Germany
  branch TEXT DEFAULT 'ঢাকা',
  status TEXT DEFAULT 'new',                  -- new, contacted, follow_up, interested, not_interested, converted
  converted_student_id TEXT REFERENCES students(id),
  counselor TEXT,
  notes TEXT,
  follow_up_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 12. Schools
CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en TEXT NOT NULL,
  name_jp TEXT,
  country TEXT DEFAULT 'Japan',
  city TEXT,
  prefecture TEXT,
  capacity INT,
  contact_email TEXT,
  contact_phone TEXT,
  website TEXT,
  commission_rate NUMERIC,
  status TEXT DEFAULT 'active',               -- active, inactive
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 13. School Submissions
CREATE TABLE submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  submission_number TEXT,
  status TEXT DEFAULT 'pending',              -- pending, accepted, rejected, interview, waiting
  submission_date DATE DEFAULT CURRENT_DATE,
  result_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 14. Batches (language courses)
CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                         -- e.g. "Batch April 2026"
  language TEXT DEFAULT 'Japanese',
  level TEXT,
  teacher TEXT,
  branch TEXT DEFAULT 'ঢাকা',
  start_date DATE,
  end_date DATE,
  capacity INT DEFAULT 30,
  schedule TEXT,                              -- e.g. "Sun-Thu, 10AM-12PM"
  status TEXT DEFAULT 'active',               -- upcoming, active, completed
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 15. Batch-Student enrollment
CREATE TABLE batch_students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(batch_id, student_id)
);

-- 16. Attendance
CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',     -- present, absent, late
  UNIQUE(date, student_id)
);

-- 17. Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,                     -- passport, nid, ssc_certificate, hsc_certificate, bank_statement, photo, etc.
  label TEXT,
  status TEXT DEFAULT 'pending',              -- pending, collected, verified, submitted
  file_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 18. Document Fields (for cross-validation)
CREATE TABLE document_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,                   -- name_en, father_en, dob, etc.
  field_value TEXT,
  UNIQUE(document_id, field_name)
);

-- 19. Income
CREATE TABLE income (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id),
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC NOT NULL,
  tax NUMERIC DEFAULT 0,
  date DATE DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'collected',
  branch TEXT DEFAULT 'ঢাকা',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 20. Expenses
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC NOT NULL,
  date DATE DEFAULT CURRENT_DATE,
  paid_by TEXT,
  branch TEXT DEFAULT 'ঢাকা',
  receipt_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 21. Employees
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  designation TEXT,
  department TEXT,
  phone TEXT,
  email TEXT,
  salary NUMERIC,
  branch TEXT DEFAULT 'ঢাকা',
  join_date DATE,
  status TEXT DEFAULT 'active',               -- active, inactive, terminated
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 22. Salary History
CREATE TABLE salary_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                        -- "2026-03"
  amount NUMERIC NOT NULL,
  method TEXT DEFAULT 'Bank Transfer',
  paid_date DATE DEFAULT CURRENT_DATE,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 23. Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT,
  student_id TEXT REFERENCES students(id),
  priority TEXT DEFAULT 'medium',             -- low, medium, high, urgent
  status TEXT DEFAULT 'pending',              -- pending, in_progress, completed
  due_date DATE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 24. Calendar Events
CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  date DATE NOT NULL,
  time TEXT,
  type TEXT DEFAULT 'general',                -- interview, deadline, meeting, exam, general
  description TEXT,
  student_id TEXT REFERENCES students(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 25. Communication Logs
CREATE TABLE communication_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                         -- call, sms, email, whatsapp, meeting
  direction TEXT DEFAULT 'outgoing',          -- incoming, outgoing
  subject TEXT,
  content TEXT,
  logged_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 26. Agents (referral agents)
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  company TEXT,
  commission_rate NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 27. Inventory
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT,
  quantity INT DEFAULT 0,
  unit_price NUMERIC DEFAULT 0,
  branch TEXT DEFAULT 'ঢাকা',
  status TEXT DEFAULT 'available',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ================================================
-- Indexes for performance
-- ================================================
CREATE INDEX idx_students_status ON students(status);
CREATE INDEX idx_students_branch ON students(branch);
CREATE INDEX idx_students_country ON students(country);
CREATE INDEX idx_students_batch ON students(batch);
CREATE INDEX idx_payments_student ON payments(student_id);
CREATE INDEX idx_payments_date ON payments(date);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_student ON attendance(student_id);
CREATE INDEX idx_visitors_status ON visitors(status);
CREATE INDEX idx_submissions_school ON submissions(school_id);
CREATE INDEX idx_submissions_student ON submissions(student_id);
CREATE INDEX idx_documents_student ON documents(student_id);
CREATE INDEX idx_income_date ON income(date);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);

-- ================================================
-- Seed: default admin user (password: admin123)
-- Change this immediately after first login!
-- ================================================
INSERT INTO users (name, email, password_hash, role, branch) VALUES
  ('Admin', 'admin@agencyos.com', '$2a$10$rQnM1v9ZxG0L1JhKF8FYJ.LY3E5U3H1c6k5y8Qp0VdW0mL1Xm2GW6', 'owner', 'ঢাকা');
-- NOTE: The above hash is a placeholder. Generate a real hash with:
--   node -e "require('bcryptjs').hash('admin123', 10).then(console.log)"
-- Then UPDATE users SET password_hash = '<real hash>' WHERE email = 'admin@agencyos.com';
