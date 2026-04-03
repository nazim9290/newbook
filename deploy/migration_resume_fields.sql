-- Resume fields — Excel入学願書 (Application for Admission) support
-- Student profile-এ missing fields যোগ

-- 1. Students table — basic missing fields
ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_place TEXT DEFAULT '';
ALTER TABLE students ADD COLUMN IF NOT EXISTS occupation TEXT DEFAULT 'Student';
ALTER TABLE students ADD COLUMN IF NOT EXISTS reason_for_study TEXT DEFAULT '';
ALTER TABLE students ADD COLUMN IF NOT EXISTS future_plan TEXT DEFAULT '';
ALTER TABLE students ADD COLUMN IF NOT EXISTS study_subject TEXT DEFAULT '';

-- 2. student_education table — entrance year + address
ALTER TABLE student_education ADD COLUMN IF NOT EXISTS entrance_year TEXT DEFAULT '';
ALTER TABLE student_education ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';
ALTER TABLE student_education ADD COLUMN IF NOT EXISTS school_type TEXT DEFAULT '';
-- school_type: elementary, junior_high, high_school, technical, junior_college, university

-- 3. student_work_experience table — 職歴 (Vocational experience)
CREATE TABLE IF NOT EXISTS student_work_experience (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT NOT NULL,
  agency_id UUID,
  company_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  position TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. student_jp_study table — 日本語学習歴 (Japanese educational history)
CREATE TABLE IF NOT EXISTS student_jp_study (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT NOT NULL,
  agency_id UUID,
  institution TEXT DEFAULT '',
  address TEXT DEFAULT '',
  period_from TEXT DEFAULT '',
  period_to TEXT DEFAULT '',
  total_hours TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. sponsors table — missing fields
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS company_phone TEXT DEFAULT '';
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS company_address TEXT DEFAULT '';

-- 6. student_family table — individual address
ALTER TABLE student_family ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';
