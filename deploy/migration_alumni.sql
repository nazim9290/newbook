-- Alumni network — track students after ARRIVED.
-- Two parts:
--   1. Static "current state" fields on students  (alumni_*)
--   2. Time-series timeline table alumni_updates  (status changes, contact log, notes)
-- Idempotent.

-- ── 1) Snapshot fields on students ───────────────────────────────
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS alumni_current_status TEXT,        -- language_school | senmon | university | employed | returned | other
  ADD COLUMN IF NOT EXISTS alumni_school_name    TEXT,        -- current institution if studying
  ADD COLUMN IF NOT EXISTS alumni_school_start   DATE,
  ADD COLUMN IF NOT EXISTS alumni_company_name   TEXT,        -- current employer if working
  ADD COLUMN IF NOT EXISTS alumni_company_position TEXT,
  ADD COLUMN IF NOT EXISTS alumni_company_start  DATE,
  ADD COLUMN IF NOT EXISTS alumni_city           TEXT,        -- e.g. Tokyo, Osaka
  ADD COLUMN IF NOT EXISTS alumni_prefecture     TEXT,        -- e.g. Tokyo-to, Osaka-fu
  ADD COLUMN IF NOT EXISTS alumni_phone_jp       TEXT,        -- Japanese phone (encrypted at rest like other phones)
  ADD COLUMN IF NOT EXISTS alumni_email_jp       TEXT,
  ADD COLUMN IF NOT EXISTS alumni_last_contact   DATE,        -- last successful follow-up
  ADD COLUMN IF NOT EXISTS alumni_referrals_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alumni_arrived_date   DATE,        -- actual arrival in Japan (separate from pipeline timestamp)
  ADD COLUMN IF NOT EXISTS alumni_notes          TEXT;

-- Index for the alumni list page (filter completed/arrived students by current state)
CREATE INDEX IF NOT EXISTS idx_students_alumni_status
  ON students(agency_id, alumni_current_status)
  WHERE alumni_current_status IS NOT NULL;

-- ── 2) Time-series updates timeline ──────────────────────────────
CREATE TABLE IF NOT EXISTS alumni_updates (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    UUID        NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  student_id   TEXT        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  update_type  TEXT        NOT NULL,                          -- status_change | school_change | company_change | contact | note | photo | referral
  title        TEXT,
  content      TEXT,
  update_date  DATE        DEFAULT CURRENT_DATE,              -- when the event happened
  attachments  JSONB       DEFAULT '[]'::jsonb,               -- [{ url, name }]
  created_by   UUID,                                          -- user who logged it
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alumni_updates_student
  ON alumni_updates(student_id, update_date DESC);
CREATE INDEX IF NOT EXISTS idx_alumni_updates_agency
  ON alumni_updates(agency_id, update_date DESC);

COMMENT ON TABLE  alumni_updates IS
  'Time-series log of post-arrival updates for students (alumni). Keyed by student_id; one row per update event.';
COMMENT ON COLUMN students.alumni_current_status IS
  'Post-arrival lifecycle: language_school / senmon / university / employed / returned / other. NULL = no alumni data yet.';
