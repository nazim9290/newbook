-- ================================================================
-- AgencyOS — Indexes for performance
-- Migration 002
-- ================================================================

-- Agencies
CREATE INDEX idx_agencies_subdomain ON agencies(subdomain);

-- Users
CREATE INDEX idx_users_agency ON users(agency_id);
CREATE INDEX idx_users_auth ON users(auth_user_id);
CREATE INDEX idx_users_email ON users(agency_id, email);

-- Visitors
CREATE INDEX idx_visitors_agency ON visitors(agency_id);
CREATE INDEX idx_visitors_status ON visitors(agency_id, status);
CREATE INDEX idx_visitors_phone ON visitors(phone);
CREATE INDEX idx_visitors_source ON visitors(agency_id, source);
CREATE INDEX idx_visitors_date ON visitors(visit_date);
CREATE INDEX idx_visitors_follow_up ON visitors(next_follow_up) WHERE next_follow_up IS NOT NULL;

-- Agents
CREATE INDEX idx_agents_agency ON agents(agency_id);
CREATE INDEX idx_agents_status ON agents(agency_id, status);

-- Schools
CREATE INDEX idx_schools_agency ON schools(agency_id);
CREATE INDEX idx_schools_country ON schools(agency_id, country);

-- Batches
CREATE INDEX idx_batches_agency ON batches(agency_id);
CREATE INDEX idx_batches_status ON batches(agency_id, status);

-- Students
CREATE INDEX idx_students_agency ON students(agency_id);
CREATE INDEX idx_students_status ON students(agency_id, status);
CREATE INDEX idx_students_country ON students(agency_id, country);
CREATE INDEX idx_students_batch ON students(batch_id);
CREATE INDEX idx_students_school ON students(school_id);
CREATE INDEX idx_students_agent ON students(agent_id);
CREATE INDEX idx_students_phone ON students(phone);
CREATE INDEX idx_students_name ON students(agency_id, name_en);

-- Student sub-tables
CREATE INDEX idx_student_education_student ON student_education(student_id);
CREATE INDEX idx_student_jp_exams_student ON student_jp_exams(student_id);
CREATE INDEX idx_student_family_student ON student_family(student_id);

-- Sponsors
CREATE INDEX idx_sponsors_student ON sponsors(student_id);
CREATE INDEX idx_sponsor_banks_sponsor ON sponsor_banks(sponsor_id);

-- Documents
CREATE INDEX idx_documents_student ON documents(student_id);
CREATE INDEX idx_documents_agency ON documents(agency_id);
CREATE INDEX idx_documents_type ON documents(agency_id, doc_type);
CREATE INDEX idx_documents_status ON documents(agency_id, status);
CREATE INDEX idx_document_fields_doc ON document_fields(document_id);

-- Submissions
CREATE INDEX idx_submissions_agency ON submissions(agency_id);
CREATE INDEX idx_submissions_school ON submissions(school_id);
CREATE INDEX idx_submissions_student ON submissions(student_id);

-- Batch Students
CREATE INDEX idx_batch_students_batch ON batch_students(batch_id);
CREATE INDEX idx_batch_students_student ON batch_students(student_id);

-- Attendance
CREATE INDEX idx_attendance_agency ON attendance(agency_id);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_student_date ON attendance(student_id, date);
CREATE INDEX idx_attendance_batch ON attendance(batch_id, date);

-- Payments
CREATE INDEX idx_payments_agency ON payments(agency_id);
CREATE INDEX idx_payments_student ON payments(student_id);
CREATE INDEX idx_payments_status ON payments(agency_id, status);
CREATE INDEX idx_payments_date ON payments(date);
CREATE INDEX idx_payment_installments_payment ON payment_installments(payment_id);

-- Expenses
CREATE INDEX idx_expenses_agency ON expenses(agency_id);
CREATE INDEX idx_expenses_date ON expenses(agency_id, date);

-- Employees & Salary
CREATE INDEX idx_employees_agency ON employees(agency_id);
CREATE INDEX idx_salary_history_employee ON salary_history(employee_id);

-- Tasks
CREATE INDEX idx_tasks_agency ON tasks(agency_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_status ON tasks(agency_id, status);
CREATE INDEX idx_tasks_due ON tasks(due_date) WHERE status != 'completed';

-- Communications
CREATE INDEX idx_communications_agency ON communications(agency_id);
CREATE INDEX idx_communications_student ON communications(student_id);
CREATE INDEX idx_communications_visitor ON communications(visitor_id);

-- Calendar
CREATE INDEX idx_calendar_agency ON calendar_events(agency_id);
CREATE INDEX idx_calendar_date ON calendar_events(agency_id, date);

-- Class Tests
CREATE INDEX idx_class_tests_batch ON class_tests(batch_id);
CREATE INDEX idx_class_test_scores_test ON class_test_scores(test_id);
CREATE INDEX idx_class_test_scores_student ON class_test_scores(student_id);

-- Activity Log
CREATE INDEX idx_activity_log_agency ON activity_log(agency_id);
CREATE INDEX idx_activity_log_user ON activity_log(user_id);
CREATE INDEX idx_activity_log_module ON activity_log(agency_id, module);
CREATE INDEX idx_activity_log_date ON activity_log(created_at);

-- Excel Templates
CREATE INDEX idx_excel_templates_agency ON excel_templates(agency_id);

-- Inventory
CREATE INDEX idx_inventory_agency ON inventory(agency_id);
