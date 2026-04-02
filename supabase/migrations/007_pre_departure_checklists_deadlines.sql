-- ═══════════════════════════════════════════════════════════════
-- 007: pre_departure table-এ checklists ও deadlines কলাম যোগ
-- checklists: প্রতিটি step-এর task list (JSONB)
-- deadlines: প্রতিটি step-এর deadline তারিখ (JSONB)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS checklists JSONB DEFAULT '{}';
ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS deadlines JSONB DEFAULT '{}';
