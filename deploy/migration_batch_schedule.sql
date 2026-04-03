-- Batch schedule — ক্লাসের দিন, সময়, ঘণ্টা
-- সপ্তাহে কোন দিন ক্লাস হবে (JSON array: ["Sun", "Mon", "Tue"])
ALTER TABLE batches ADD COLUMN IF NOT EXISTS class_days JSONB DEFAULT '[]';

-- প্রতি ক্লাস কত ঘণ্টা
ALTER TABLE batches ADD COLUMN IF NOT EXISTS class_hours_per_day NUMERIC DEFAULT 2;

-- ক্লাসের সময় (যেমন "10:00 AM - 12:00 PM")
ALTER TABLE batches ADD COLUMN IF NOT EXISTS class_time TEXT DEFAULT '';

-- মোট ঘণ্টা (auto-calculated বা manual)
ALTER TABLE batches ADD COLUMN IF NOT EXISTS total_hours NUMERIC DEFAULT 0;

-- মোট ক্লাস সংখ্যা
ALTER TABLE batches ADD COLUMN IF NOT EXISTS total_classes INT DEFAULT 0;

-- সাপ্তাহিক ঘণ্টা
ALTER TABLE batches ADD COLUMN IF NOT EXISTS weekly_hours NUMERIC DEFAULT 0;
