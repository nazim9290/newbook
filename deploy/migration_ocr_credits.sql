-- ═══════════════════════════════════════════════════════
-- OCR Credit System — Agency-wise credit balance + usage tracking
-- ═══════════════════════════════════════════════════════

-- Agency table-এ OCR credit balance যোগ
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS ocr_credits NUMERIC DEFAULT 0;

-- OCR usage tracking table — প্রতিটি scan log
CREATE TABLE IF NOT EXISTS ocr_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  doc_type TEXT,
  engine TEXT DEFAULT 'haiku',  -- 'haiku' বা 'google_vision'
  credits_used NUMERIC DEFAULT 1,
  confidence TEXT,
  fields_extracted INT DEFAULT 0,
  file_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- OCR credit transaction log — credit add/deduct history
CREATE TABLE IF NOT EXISTS ocr_credit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,          -- positive = credit added, negative = deducted
  balance_after NUMERIC NOT NULL,   -- transaction-এর পর balance
  type TEXT NOT NULL,               -- 'topup', 'scan', 'refund', 'bonus'
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index — agency-wise lookup দ্রুত করতে
CREATE INDEX IF NOT EXISTS idx_ocr_usage_agency ON ocr_usage(agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_credit_log_agency ON ocr_credit_log(agency_id, created_at DESC);
