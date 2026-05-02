-- ═══════════════════════════════════════════════════════════════
-- migration_soft_delete.sql — Soft Delete Infrastructure
-- ═══════════════════════════════════════════════════════════════
--
-- Policy: Soft delete preserves audit trail. Physical purge happens
-- via scheduled cleanup after retention window (default 90 days).
-- Reads must filter `WHERE deleted_at IS NULL` unless explicitly
-- querying trash.
--
-- Compliance: GDPR (right-to-be-forgotten honored after retention),
-- audit trail preservation (activity_log references survive),
-- restorable accidental deletes within window.
--
-- Idempotent: safe to re-run — uses IF NOT EXISTS pattern via DO block.
-- Append-only: does not alter or drop any existing column.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'visitors', 'students', 'agents', 'schools', 'partners',
    'employees', 'communications', 'documents', 'payments',
    'batches', 'branches', 'holidays', 'tasks', 'alumni',
    'inventory', 'broadcasts', 'feedback', 'calendar_events',
    'leaves', 'attendance', 'accounts'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    -- Add deleted_at column only if the table exists AND column missing.
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'deleted_at'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN deleted_at TIMESTAMPTZ', t);
      RAISE NOTICE 'Added deleted_at to %', t;
    ELSE
      RAISE NOTICE 'Skipped % (table missing or column exists)', t;
    END IF;
  END LOOP;
END
$$;

-- ── Partial indexes — fast list queries that skip soft-deleted rows ──
-- Each index covers (agency_id) WHERE deleted_at IS NULL so that the
-- common multi-tenant list path stays index-only.
CREATE INDEX IF NOT EXISTS idx_visitors_active        ON visitors(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_students_active        ON students(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agents_active          ON agents(agency_id)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schools_active         ON schools(agency_id)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partners_active        ON partners(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees_active       ON employees(agency_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_communications_active  ON communications(agency_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_active       ON documents(agency_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_active        ON payments(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_batches_active         ON batches(agency_id)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_branches_active        ON branches(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_holidays_active        ON holidays(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_active           ON tasks(agency_id)           WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alumni_active          ON alumni(agency_id)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_active       ON inventory(agency_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcasts_active      ON broadcasts(agency_id)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_active        ON feedback(agency_id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_active ON calendar_events(agency_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leaves_active          ON leaves(agency_id)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_active      ON attendance(agency_id)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_active        ON accounts(agency_id)        WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- Done. Next: roll out soft-delete in route handlers (see
-- deploy/SOFT_DELETE_ROLLOUT.md). The migration is backward-safe:
-- routes that still issue physical DELETE keep working; only
-- migrated routes will populate deleted_at.
-- ═══════════════════════════════════════════════════════════════
