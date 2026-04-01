-- Studentship Certificate (Running Student Certificate)
-- Category: academic | Used for translation to Japanese

DELETE FROM doc_types WHERE name = 'Studentship Certificate';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Studentship Certificate',
  'ছাত্রত্ব সনদ',
  'academic',
  '[
    { "key": "section_inst", "label_en": "Institution Details", "type": "section_header" },
    { "key": "institution_name", "label_en": "Institution Name", "type": "text", "required": true },
    { "key": "department", "label_en": "Department", "type": "text" },
    { "key": "institution_address", "label_en": "Institution Address", "type": "text" },
    { "key": "ref_no", "label_en": "Reference No", "type": "text" },
    { "key": "cert_date", "label_en": "Date", "type": "date" },

    { "key": "section_student", "label_en": "Student Details", "type": "section_header" },
    { "key": "name_en", "label_en": "Student Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },

    { "key": "section_program", "label_en": "Program Details", "type": "section_header" },
    { "key": "degree", "label_en": "Degree/Program", "type": "text", "required": true },
    { "key": "subject", "label_en": "Subject/Major", "type": "text" },
    { "key": "year", "label_en": "Current Year/Semester", "type": "text" },
    { "key": "roll_no", "label_en": "Class Roll Number", "type": "text" },
    { "key": "session", "label_en": "Academic Session", "type": "text" },
    { "key": "student_type", "label_en": "Student Type", "type": "select", "options": ["Regular", "Irregular", "Private"] }
  ]'::jsonb,
  true,
  13
FROM agencies
ON CONFLICT DO NOTHING;
