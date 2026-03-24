-- ================================================================
-- AgencyOS — Row Level Security (RLS)
-- Migration 003: Multi-tenant isolation by agency_id
-- ================================================================

-- Helper function: get current user's agency_id from JWT
CREATE OR REPLACE FUNCTION current_user_agency_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT agency_id FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Helper function: get current user's role
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Helper function: get current user's id
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- ================================================================
-- Enable RLS on all tables
-- ================================================================
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_education ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_jp_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_family ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsor_banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_test_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE excel_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;

-- ================================================================
-- AGENCIES — users can only see their own agency
-- ================================================================
CREATE POLICY agencies_select ON agencies FOR SELECT
  USING (id = current_user_agency_id());

CREATE POLICY agencies_update ON agencies FOR UPDATE
  USING (id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- ================================================================
-- USERS — same agency only
-- ================================================================
CREATE POLICY users_select ON users FOR SELECT
  USING (agency_id = current_user_agency_id());

CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

CREATE POLICY users_update ON users FOR UPDATE
  USING (agency_id = current_user_agency_id() AND (id = current_user_id() OR current_user_role() IN ('owner', 'manager')));

CREATE POLICY users_delete ON users FOR DELETE
  USING (agency_id = current_user_agency_id() AND current_user_role() = 'owner');

-- ================================================================
-- Macro: standard agency-scoped CRUD policies
-- We create SELECT/INSERT/UPDATE/DELETE for each table with agency_id
-- ================================================================

-- VISITORS
CREATE POLICY visitors_select ON visitors FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY visitors_insert ON visitors FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY visitors_update ON visitors FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY visitors_delete ON visitors FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- AGENTS
CREATE POLICY agents_select ON agents FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY agents_insert ON agents FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY agents_update ON agents FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY agents_delete ON agents FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- SCHOOLS
CREATE POLICY schools_select ON schools FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY schools_insert ON schools FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY schools_update ON schools FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY schools_delete ON schools FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- BATCHES
CREATE POLICY batches_select ON batches FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY batches_insert ON batches FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY batches_update ON batches FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY batches_delete ON batches FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- STUDENTS
CREATE POLICY students_select ON students FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY students_insert ON students FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY students_update ON students FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY students_delete ON students FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- STUDENT_EDUCATION (via student's agency)
CREATE POLICY student_education_select ON student_education FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_insert ON student_education FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_update ON student_education FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_education_delete ON student_education FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- STUDENT_JP_EXAMS
CREATE POLICY student_jp_exams_select ON student_jp_exams FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_insert ON student_jp_exams FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_update ON student_jp_exams FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_jp_exams_delete ON student_jp_exams FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- STUDENT_FAMILY
CREATE POLICY student_family_select ON student_family FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_insert ON student_family FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_update ON student_family FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY student_family_delete ON student_family FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- SPONSORS
CREATE POLICY sponsors_select ON sponsors FOR SELECT
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_insert ON sponsors FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_update ON sponsors FOR UPDATE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsors_delete ON sponsors FOR DELETE
  USING (EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND s.agency_id = current_user_agency_id()));

-- SPONSOR_BANKS (via sponsor → student)
CREATE POLICY sponsor_banks_select ON sponsor_banks FOR SELECT
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_insert ON sponsor_banks FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_update ON sponsor_banks FOR UPDATE
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));
CREATE POLICY sponsor_banks_delete ON sponsor_banks FOR DELETE
  USING (EXISTS (SELECT 1 FROM sponsors sp JOIN students s ON s.id = sp.student_id WHERE sp.id = sponsor_id AND s.agency_id = current_user_agency_id()));

-- DOCUMENTS
CREATE POLICY documents_select ON documents FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY documents_update ON documents FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY documents_delete ON documents FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- DOCUMENT_FIELDS (via document's agency)
CREATE POLICY document_fields_select ON document_fields FOR SELECT
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_insert ON document_fields FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_update ON document_fields FOR UPDATE
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));
CREATE POLICY document_fields_delete ON document_fields FOR DELETE
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.agency_id = current_user_agency_id()));

-- SUBMISSIONS
CREATE POLICY submissions_select ON submissions FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY submissions_insert ON submissions FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY submissions_update ON submissions FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY submissions_delete ON submissions FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- BATCH_STUDENTS (via batch's agency)
CREATE POLICY batch_students_select ON batch_students FOR SELECT
  USING (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));
CREATE POLICY batch_students_insert ON batch_students FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));
CREATE POLICY batch_students_delete ON batch_students FOR DELETE
  USING (EXISTS (SELECT 1 FROM batches b WHERE b.id = batch_id AND b.agency_id = current_user_agency_id()));

-- ATTENDANCE
CREATE POLICY attendance_select ON attendance FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY attendance_insert ON attendance FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY attendance_update ON attendance FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY attendance_delete ON attendance FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- PAYMENTS
CREATE POLICY payments_select ON payments FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY payments_update ON payments FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY payments_delete ON payments FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- PAYMENT_INSTALLMENTS (via payment's agency)
CREATE POLICY payment_installments_select ON payment_installments FOR SELECT
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));
CREATE POLICY payment_installments_insert ON payment_installments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));
CREATE POLICY payment_installments_delete ON payment_installments FOR DELETE
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND p.agency_id = current_user_agency_id()));

-- EXPENSES
CREATE POLICY expenses_select ON expenses FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY expenses_insert ON expenses FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY expenses_update ON expenses FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY expenses_delete ON expenses FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));

-- EMPLOYEES
CREATE POLICY employees_select ON employees FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY employees_insert ON employees FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY employees_update ON employees FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY employees_delete ON employees FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() = 'owner');

-- SALARY_HISTORY (via employee's agency)
CREATE POLICY salary_history_select ON salary_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.agency_id = current_user_agency_id()));
CREATE POLICY salary_history_insert ON salary_history FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_id AND e.agency_id = current_user_agency_id()));

-- TASKS
CREATE POLICY tasks_select ON tasks FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY tasks_insert ON tasks FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY tasks_delete ON tasks FOR DELETE USING (agency_id = current_user_agency_id());

-- COMMUNICATIONS
CREATE POLICY comms_select ON communications FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY comms_insert ON communications FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY comms_update ON communications FOR UPDATE USING (agency_id = current_user_agency_id());

-- CALENDAR_EVENTS
CREATE POLICY calendar_select ON calendar_events FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY calendar_insert ON calendar_events FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY calendar_update ON calendar_events FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY calendar_delete ON calendar_events FOR DELETE USING (agency_id = current_user_agency_id());

-- CLASS_TESTS
CREATE POLICY class_tests_select ON class_tests FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY class_tests_insert ON class_tests FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY class_tests_update ON class_tests FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY class_tests_delete ON class_tests FOR DELETE USING (agency_id = current_user_agency_id());

-- CLASS_TEST_SCORES (via test's agency)
CREATE POLICY class_test_scores_select ON class_test_scores FOR SELECT
  USING (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));
CREATE POLICY class_test_scores_insert ON class_test_scores FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));
CREATE POLICY class_test_scores_update ON class_test_scores FOR UPDATE
  USING (EXISTS (SELECT 1 FROM class_tests ct WHERE ct.id = test_id AND ct.agency_id = current_user_agency_id()));

-- EXCEL_TEMPLATES
CREATE POLICY excel_templates_select ON excel_templates FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_insert ON excel_templates FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_update ON excel_templates FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY excel_templates_delete ON excel_templates FOR DELETE USING (agency_id = current_user_agency_id());

-- ACTIVITY_LOG
CREATE POLICY activity_log_select ON activity_log FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY activity_log_insert ON activity_log FOR INSERT WITH CHECK (agency_id = current_user_agency_id());

-- INVENTORY
CREATE POLICY inventory_select ON inventory FOR SELECT USING (agency_id = current_user_agency_id());
CREATE POLICY inventory_insert ON inventory FOR INSERT WITH CHECK (agency_id = current_user_agency_id());
CREATE POLICY inventory_update ON inventory FOR UPDATE USING (agency_id = current_user_agency_id());
CREATE POLICY inventory_delete ON inventory FOR DELETE USING (agency_id = current_user_agency_id() AND current_user_role() IN ('owner', 'manager'));
