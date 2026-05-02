-- ═══════════════════════════════════════════════════════════════════════
-- Invoice Email Delivery Tracking — Phase 4A
-- ───────────────────────────────────────────────────────────────────────
-- Auto-email আগে: invoice generate → email pathway নেই, super-admin manually
-- forward করতেন। এই migration tracking column যোগ করে যাতে আমরা জানি
-- কোন invoice কখন email পাঠানো হয়েছে / fail করেছে।
-- ═══════════════════════════════════════════════════════════════════════

-- email_sent_at — নাল = এখনো পাঠানো হয়নি, ISO timestamp = সফল
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;

-- email_status: 'pending' | 'sent' | 'failed' | 'bounced'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'pending';

-- email_error — last failure reason (debug + super-admin display)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_error TEXT;

-- email_attempts — retry counter (max 3 attempts in cron)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_attempts INT DEFAULT 0;

-- Index — যেসব invoice email pending/failed, cron retry-এ ফাস্ট lookup
CREATE INDEX IF NOT EXISTS idx_invoices_email_pending
  ON invoices(email_status, email_attempts)
  WHERE email_status IN ('pending', 'failed');

-- Optional: agency.billing_email (যদি invoice আলাদা email-এ পাঠাতে চায়)
-- Default: agency.email (owner email)
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS billing_email TEXT;

COMMENT ON COLUMN invoices.email_sent_at IS 'Timestamp when invoice email was successfully delivered to SMTP. NULL = not yet sent.';
COMMENT ON COLUMN invoices.email_status IS 'pending (not attempted yet) | sent | failed | bounced';
COMMENT ON COLUMN agencies.billing_email IS 'Optional separate email for invoices. Falls back to agencies.email if NULL.';
