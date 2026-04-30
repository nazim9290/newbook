-- Sponsor extra fields — sync prod columns into dev/new envs.
-- These columns are used by SponsorTab UI (Tax Info section) and the
-- Documents cross-validation flow. Production already has them; this is
-- the captured migration so dev / future setups stay in sync.

ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS father_name TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS mother_name TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS present_address TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS permanent_address TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_year_1 TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_year_2 TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_year_3 TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_source_1 TEXT DEFAULT 'Business Income';
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_source_2 TEXT DEFAULT 'Business Income';
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS income_source_3 TEXT DEFAULT 'Business Income';
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS work_address TEXT;
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS trade_license_no TEXT;
