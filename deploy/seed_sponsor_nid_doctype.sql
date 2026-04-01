-- Sponsor NID doc type — National ID Card (Old + Smart Card format)
-- Category: sponsor | OCR auto-detect both formats

DELETE FROM doc_types WHERE name = 'Sponsor NID';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Sponsor NID',
  'স্পন্সরের এনআইডি',
  'sponsor',
  '[
    { "key": "section_nid", "label_en": "NID Details", "type": "section_header" },
    { "key": "nid_format", "label_en": "NID Format", "type": "select", "options": ["Old (Laminated)", "Smart Card"] },
    { "key": "nid_number", "label_en": "NID Number", "type": "text", "required": true },

    { "key": "section_personal", "label_en": "Personal Information", "type": "section_header" },
    { "key": "name_en", "label_en": "Name (English)", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "dob", "label_en": "Date of Birth", "type": "date", "required": true },
    { "key": "blood_group", "label_en": "Blood Group", "type": "select", "options": ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] },
    { "key": "birth_place", "label_en": "Place of Birth", "type": "text", "condition": { "when": "nid_format", "equals": "Smart Card" } },

    { "key": "section_address", "label_en": "Address", "type": "section_header" },
    { "key": "address", "label_en": "Permanent Address", "type": "text" },

    { "key": "section_issue", "label_en": "Issue Details", "type": "section_header" },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" }
  ]'::jsonb,
  true,
  8
FROM agencies
ON CONFLICT DO NOTHING;
