-- ═══════════════════════════════════════════════════════════════════════
-- migration_2026_05_03_notifications_inbox.sql — in-app inbox tracking.
--
-- notifications_sent already records every send (with user_id, channel,
-- subject, data, sent_at, status). To turn it into an in-app feed we
-- just need a per-user "read" timestamp.
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE notifications_sent
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Hot index: user inbox query "give me my recent notifications, unread first"
CREATE INDEX IF NOT EXISTS idx_notif_sent_user_inbox
  ON notifications_sent(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Hot index: unread count badge ("how many unread for this user")
CREATE INDEX IF NOT EXISTS idx_notif_sent_user_unread
  ON notifications_sent(user_id)
  WHERE user_id IS NOT NULL AND read_at IS NULL;
