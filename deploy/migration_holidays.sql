-- ═══════════════════════════════════════════════════════
-- holidays — সরকারি ছুটি ও বিশেষ দিবসের তালিকা
-- agency_id অনুযায়ী আলাদা ছুটি সেট করা যাবে
-- recurring = true হলে প্রতিবছর একই তারিখে ছুটি (ভাষা দিবস, স্বাধীনতা দিবস ইত্যাদি)
-- batch hours calculation-এ এই ছুটির দিনগুলো বাদ যাবে
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS holidays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL,
  date DATE NOT NULL,
  name TEXT NOT NULL,
  name_bn TEXT,
  recurring BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- agency_id দিয়ে দ্রুত query — সব ছুটি একটি agency-র জন্য
CREATE INDEX IF NOT EXISTS idx_holidays_agency ON holidays(agency_id);

-- একই agency-তে একই তারিখে duplicate ছুটি যেন না থাকে
CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_agency_date ON holidays(agency_id, date);
