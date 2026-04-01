-- Japanese Language Proficiency Certificate + Learning Certificate
-- Category: academic | OCR parser support
-- Language school থেকে দেওয়া সার্টিফিকেট — প্রতিটি agency আলাদা format ব্যবহার করে

DELETE FROM doc_types WHERE name IN ('Language Proficiency Certificate', 'Learning Certificate');

-- ═══════════════════════════════════════════════════════════
-- A) Language Proficiency Certificate (日本語能力証明書) — sort_order 11
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Language Proficiency Certificate',
  'ভাষা দক্ষতা সনদ',
  'academic',
  '[
    { "key": "section_cert", "label_en": "Certificate Details", "type": "section_header" },
    { "key": "sl_no", "label_en": "Serial / Ref No", "type": "text" },
    { "key": "institute_name", "label_en": "Institute Name", "type": "text", "required": true },
    { "key": "cert_date", "label_en": "Certificate Date", "type": "date" },

    { "key": "section_student", "label_en": "Student Information", "type": "section_header" },
    { "key": "name_en", "label_en": "Student Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "student_id", "label_en": "Student ID", "type": "text" },
    { "key": "dob", "label_en": "Date of Birth", "type": "date" },

    { "key": "section_course", "label_en": "Course Details", "type": "section_header" },
    { "key": "course_level", "label_en": "Level (N5/N4/N3/N2/N1)", "type": "select", "options": ["N5", "N4", "N3", "N2", "N1"] },
    { "key": "total_hours", "label_en": "Total Course Hours", "type": "text" },
    { "key": "attended_hours", "label_en": "Attended Hours", "type": "text" },
    { "key": "grade", "label_en": "Grade Obtained", "type": "select", "options": ["A+", "A", "A-", "B+", "B", "C", "D", "F"] },
    { "key": "course_from", "label_en": "Course Duration From", "type": "date" },
    { "key": "course_to", "label_en": "Course Duration To", "type": "date" }
  ]'::jsonb,
  true,
  11
FROM agencies
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- B) Learning Certificate (学習証明書) — sort_order 12
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Learning Certificate',
  'লার্নিং সার্টিফিকেট',
  'academic',
  '[
    { "key": "section_cert", "label_en": "Certificate Details", "type": "section_header" },
    { "key": "ref_no", "label_en": "Reference No", "type": "text" },
    { "key": "cert_date", "label_en": "Date", "type": "date" },
    { "key": "institute_name", "label_en": "Institute Name", "type": "text", "required": true },

    { "key": "section_student", "label_en": "Student Information", "type": "section_header" },
    { "key": "name_en", "label_en": "Student Name", "type": "text", "required": true },
    { "key": "student_id", "label_en": "Student ID", "type": "text" },

    { "key": "section_course", "label_en": "Course & Duration", "type": "section_header" },
    { "key": "learning_period", "label_en": "Learning Period", "type": "text" },
    { "key": "course_level", "label_en": "Level", "type": "select", "options": ["N5", "N4", "N3", "N2", "N1"] },
    { "key": "reference_book", "label_en": "Reference Book", "type": "text" },
    { "key": "total_classes", "label_en": "Total Number of Classes", "type": "text" },
    { "key": "total_hours", "label_en": "Total Number of Hours", "type": "text" },
    { "key": "class_duration", "label_en": "Class Duration Per Day", "type": "text" },
    { "key": "weekly_duration", "label_en": "Duration Per Week", "type": "text" },
    { "key": "class_time", "label_en": "Class Time", "type": "text" },

    { "key": "section_performance", "label_en": "Performance", "type": "section_header" },
    { "key": "attendance_rate", "label_en": "Attendance Rate (%)", "type": "text" },
    { "key": "total_study_hours", "label_en": "Total Study Hours", "type": "text" },
    { "key": "class_test_rate", "label_en": "Class Test Participation Rate (%)", "type": "text" },

    { "key": "section_skills", "label_en": "Skill-wise Performance", "type": "section_header" },
    { "key": "skills", "label_en": "Skills", "type": "repeatable", "subfields": [
      { "key": "Skill", "label_en": "Skill", "type": "select", "options": ["Listening", "Speaking", "Reading", "Writing"] },
      { "key": "Score", "label_en": "Score (%)", "type": "text" }
    ]}
  ]'::jsonb,
  true,
  12
FROM agencies
ON CONFLICT DO NOTHING;
