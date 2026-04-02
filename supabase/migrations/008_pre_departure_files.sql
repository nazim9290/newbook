-- ═══════════════════════════════════════════════════════
-- Migration: pre_departure table-এ files JSONB column যোগ
-- প্রতিটি step-এ আপলোড করা ডকুমেন্ট (health cert, visa copy, etc.) রাখবে
-- ═══════════════════════════════════════════════════════

ALTER TABLE pre_departure ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]';

-- files column-এর structure:
-- [
--   {
--     "id": "f_1712000000000",
--     "step": "health",
--     "name": "health_cert.pdf",
--     "url": "/uploads/pre-departure/studentId_1712000000_health_cert.pdf",
--     "size": 1234567,
--     "uploaded_at": "2026-04-02"
--   }
-- ]

COMMENT ON COLUMN pre_departure.files IS 'প্রতিটি step-এ আপলোড করা ডকুমেন্ট (JSONB array)';
