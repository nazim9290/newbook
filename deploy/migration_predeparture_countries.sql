-- ═══════════════════════════════════════════════════════════
-- Pre-Departure country-specific columns migration
-- Germany: admission_letter, blocked_account, insurance
-- Korea: admission_topik, d4_visa, arc_card
-- Common new: step_status (JSONB for flexible step tracking)
-- ═══════════════════════════════════════════════════════════

-- Germany-specific fields
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS admission_letter_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS admission_letter_date DATE;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS blocked_account_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS blocked_account_date DATE;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS blocked_account_amount NUMERIC DEFAULT 0;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS insurance_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS insurance_date DATE;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS insurance_provider TEXT;

-- Korea-specific fields
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS admission_topik_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS admission_topik_date DATE;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS admission_topik_score TEXT;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS d4_visa_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS d4_visa_date DATE;
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS arc_card_status TEXT DEFAULT 'pending';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS arc_card_date DATE;
