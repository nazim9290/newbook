-- AgencyBook — পারফরম্যান্স ইনডেক্স (স্কেলিং)
-- Run on production: psql -U agencybook -d agencybook_db -f migration_indexes.sql

-- payments: agency + status filter
CREATE INDEX IF NOT EXISTS idx_payments_agency_status ON payments(agency_id, status);

-- documents: student + status filter
CREATE INDEX IF NOT EXISTS idx_documents_student_status ON documents(student_id, status);

-- activity_log: agency + date sort (DESC for recent first)
CREATE INDEX IF NOT EXISTS idx_activity_log_agency_date ON activity_log(agency_id, created_at DESC);

-- submissions: agency + status filter
CREATE INDEX IF NOT EXISTS idx_submissions_agency_status ON submissions(agency_id, status);

-- users: agency scoping
CREATE INDEX IF NOT EXISTS idx_users_agency ON users(agency_id);

-- communications: agency + date sort
CREATE INDEX IF NOT EXISTS idx_communications_agency_date ON communications(agency_id, created_at DESC);

-- batch_students: batch_id for count queries
CREATE INDEX IF NOT EXISTS idx_batch_students_batch ON batch_students(batch_id);

-- expenses: agency + date
CREATE INDEX IF NOT EXISTS idx_expenses_agency_date ON expenses(agency_id, date DESC);
