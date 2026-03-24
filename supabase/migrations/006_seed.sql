-- ================================================================
-- AgencyOS — Seed Data (demo agency)
-- Migration 006
-- Run AFTER auth setup. Adjust auth_user_id after first login.
-- ================================================================

-- Create demo agency
INSERT INTO agencies (id, subdomain, name, name_bn, phone, email, status, plan) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'demo-agency', 'Demo Education Agency', 'ডেমো এডুকেশন এজেন্সি', '01700000000', 'admin@agencyos.com', 'active', 'pro');

-- Create admin user (auth_user_id will be linked after first Supabase Auth login)
INSERT INTO users (id, agency_id, name, email, role, branch, is_active) VALUES
  ('u0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Admin', 'admin@agencyos.com', 'owner', 'Main', true);

-- Sample agents
INSERT INTO agents (agency_id, name, phone, area, commission_per_student, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Hafizur Rahman', '01712340010', 'Comilla', 10000, 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Abdur Rahim', '01812340020', 'Sylhet', 8000, 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Kamrul Hasan', '01912340030', 'Dhaka', 12000, 'active');

-- Sample schools
INSERT INTO schools (agency_id, name_en, name_jp, country, city, tuition_y1, min_jp_level, interview_type, has_dormitory) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Tokyo Galaxy Japanese School', '東京ギャラクシー日本語学校', 'Japan', 'Tokyo', 780000, 'N5', 'online', true),
  ('a0000000-0000-0000-0000-000000000001', 'Osaka Minami Japanese School', '大阪みなみ日本語学校', 'Japan', 'Osaka', 720000, 'N5', 'online', false),
  ('a0000000-0000-0000-0000-000000000001', 'ISI Language School', 'ISI日本語学校', 'Japan', 'Tokyo', 850000, 'N4', 'in-person', true);

-- Sample batches
INSERT INTO batches (agency_id, name, level, start_date, end_date, capacity, schedule, teacher, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Batch April 2026', 'N5', '2025-12-01', '2026-03-31', 25, 'Sun-Thu 10AM-12PM', 'Sensei Tanaka', 'active'),
  ('a0000000-0000-0000-0000-000000000001', 'Batch October 2026', 'N5', '2026-04-01', '2026-09-30', 30, 'Sun-Thu 2PM-4PM', 'Sensei Yamada', 'upcoming');
