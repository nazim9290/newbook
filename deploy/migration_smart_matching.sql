-- ══════════════════════════════════════════════════════════════
-- Smart Matching Migration — Student-School Interview Shortlisting
-- Run: psql -U agencybook -h 127.0.0.1 -d agencybook_db -f deploy/migration_smart_matching.sql
-- Safe: সব IF NOT EXISTS — বারবার চালানো যাবে
-- ══════════════════════════════════════════════════════════════

-- ── 1. Schools — intake-wise requirements (JSONB) ──
-- Format: [{"month":"April","year":2026,"min_jp_level":"N5","min_education":"HSC","min_age":18,"max_age":30,"seats":20}]
ALTER TABLE schools ADD COLUMN IF NOT EXISTS intake_requirements JSONB DEFAULT '[]'::jsonb;

-- ── 2. Schools — region (Japan region grouping) ──
-- Values: Hokkaido, Tohoku, Kanto, Chubu, Kansai, Chugoku, Shikoku, Kyushu, Okinawa
ALTER TABLE schools ADD COLUMN IF NOT EXISTS region TEXT;

-- ── 3. Students — preferred region (optional) ──
ALTER TABLE students ADD COLUMN IF NOT EXISTS preferred_region TEXT;

-- ── 4. Schools — immigration_bureau (code-এ reference আছে কিন্তু column ছিল না) ──
ALTER TABLE schools ADD COLUMN IF NOT EXISTS immigration_bureau TEXT;

-- ══════════════════════════════════════
-- Migration Complete!
-- ══════════════════════════════════════
