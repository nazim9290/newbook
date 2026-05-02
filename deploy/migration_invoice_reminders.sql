-- ═══════════════════════════════════════════════════════════════════════
-- Invoice Past-Due Reminder Tracking — Phase 4A.5
-- ───────────────────────────────────────────────────────────────────────
-- Daily reminder cron-এর জন্য এই দুটো column লাগবে:
--   - last_reminder_sent_at: প্রতিদিন একবারের বেশি না পাঠাতে
--   - reminder_count: সর্বোচ্চ ৭ বার (Section 4.5: past_due window 7 দিন)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reminder_count INT DEFAULT 0;

-- Index — past-due lookup দ্রুত করতে (cron প্রতিদিন এই query চালাবে)
CREATE INDEX IF NOT EXISTS idx_invoices_past_due
  ON invoices(status, due_date, last_reminder_sent_at)
  WHERE status IN ('sent', 'overdue');

COMMENT ON COLUMN invoices.last_reminder_sent_at IS 'Last past-due reminder email timestamp. NULL = never reminded.';
COMMENT ON COLUMN invoices.reminder_count IS 'Total past-due reminders sent for this invoice. Capped at 7 per Section 4.5.';
