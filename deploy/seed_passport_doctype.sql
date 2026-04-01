-- Passport doc type — Bangladesh MRP (Machine Readable Passport)
-- Category: personal | OCR parser support
-- Personal Data page + Emergency Contact page

DELETE FROM doc_types WHERE name = 'Passport';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Passport',
  'পাসপোর্ট',
  'personal',
  '[
    { "key": "section_passport", "label_en": "Passport Details", "type": "section_header" },
    { "key": "passport_number", "label_en": "Passport Number", "type": "text", "required": true },
    { "key": "type", "label_en": "Type", "type": "select", "options": ["P", "D", "S"] },
    { "key": "country_code", "label_en": "Country Code", "type": "text" },
    { "key": "date_of_issue", "label_en": "Date of Issue", "type": "date" },
    { "key": "date_of_expiry", "label_en": "Date of Expiry", "type": "date" },
    { "key": "issuing_authority", "label_en": "Issuing Authority", "type": "text" },

    { "key": "section_personal", "label_en": "Personal Information", "type": "section_header" },
    { "key": "surname", "label_en": "Surname", "type": "text", "required": true },
    { "key": "given_name", "label_en": "Given Name", "type": "text", "required": true },
    { "key": "nationality", "label_en": "Nationality", "type": "text" },
    { "key": "personal_no", "label_en": "Personal No (NID)", "type": "text" },
    { "key": "dob", "label_en": "Date of Birth", "type": "date", "required": true },
    { "key": "sex", "label_en": "Sex", "type": "select", "options": ["M", "F"] },
    { "key": "birth_place", "label_en": "Place of Birth", "type": "text" },

    { "key": "section_names", "label_en": "Family (Personal Data Page)", "type": "section_header" },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "permanent_address", "label_en": "Permanent Address", "type": "text" },

    { "key": "section_emergency", "label_en": "Emergency Contact", "type": "section_header" },
    { "key": "emergency_name", "label_en": "Emergency Contact Name", "type": "text" },
    { "key": "emergency_relationship", "label_en": "Relationship", "type": "text" },
    { "key": "emergency_address", "label_en": "Emergency Contact Address", "type": "text" },
    { "key": "emergency_phone", "label_en": "Telephone No", "type": "text" },

    { "key": "section_old", "label_en": "Previous Passport", "type": "section_header" },
    { "key": "previous_passport_no", "label_en": "Previous Passport No", "type": "text" }
  ]'::jsonb,
  true,
  10
FROM agencies
ON CONFLICT DO NOTHING;
