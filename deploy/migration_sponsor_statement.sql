-- ══════════════════════════════════════════════════════
-- Migration: 経費支弁書 (Financial Sponsorship Document) fields
-- sponsors table-এ নতুন columns যোগ — statement, payment routing, sign date
-- ══════════════════════════════════════════════════════

-- স্পনসরের বিবৃতি — কেন স্পনসর করছেন, সম্পর্ক ইত্যাদি
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS statement TEXT DEFAULT '';

-- পেমেন্ট ছাত্রের অ্যাকাউন্টে যাবে কিনা
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_to_student BOOLEAN DEFAULT false;

-- পেমেন্ট স্কুলের অ্যাকাউন্টে যাবে কিনা
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS payment_to_school BOOLEAN DEFAULT true;

-- স্বাক্ষরের তারিখ
ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS sign_date DATE;
