-- ═══════════════════════════════════════════════════════
-- HR Leaves — কর্মচারীদের ছুটি আবেদন
-- ═══════════════════════════════════════════════════════
-- src/routes/hr.js GET/POST/PATCH/DELETE /leaves এ ব্যবহৃত

CREATE TABLE IF NOT EXISTS leaves (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id    UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'casual',     -- casual / sick / annual / unpaid
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  days         INTEGER NOT NULL DEFAULT 1,
  reason       TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending / approved / rejected
  notes        TEXT,
  approved_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- agency_id + start_date most-common query path
CREATE INDEX IF NOT EXISTS idx_leaves_agency_start ON leaves(agency_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_leaves_employee     ON leaves(employee_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status       ON leaves(status) WHERE status = 'pending';
