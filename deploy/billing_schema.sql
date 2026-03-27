-- AgencyBook Billing Schema

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS per_student_fee NUMERIC DEFAULT 3000;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS total_billed NUMERIC DEFAULT 0;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS total_paid NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES
('pricing', '{"per_student_fee": 3000, "trial_days": 14, "currency": "BDT"}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS billing_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students(id),
  event TEXT NOT NULL DEFAULT 'student_enrolled',
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

UPDATE agencies SET trial_ends_at = now() + interval '14 days', per_student_fee = 3000
WHERE id = 'a0000000-0000-0000-0000-000000000001' AND trial_ends_at IS NULL;
