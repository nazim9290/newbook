-- ═══════════════════════════════════════════════════════
-- User Preferences — ইউজার-ভিত্তিক সেটিংস (কলাম কনফিগ ইত্যাদি)
-- ═══════════════════════════════════════════════════════
-- preferences JSONB: { students_columns: ["id","name_en",...], ... }
-- প্রতিটি ইউজারের নিজের সেটিং — লগইন করলে যেকোনো ডিভাইসে দেখাবে

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
