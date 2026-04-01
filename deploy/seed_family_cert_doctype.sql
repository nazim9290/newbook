-- Family Relation Certificate doc type
-- Category: personal | OCR parser support

DELETE FROM doc_types WHERE name = 'Family Relation Certificate';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Family Relation Certificate',
  'পারিবারিক সম্পর্ক সনদ',
  'personal',
  '[
    { "key": "section_cert", "label_en": "Certificate Details", "type": "section_header" },
    { "key": "certificate_no", "label_en": "Certificate No", "type": "text" },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
    { "key": "issuing_authority", "label_en": "Issuing Authority", "type": "text" },

    { "key": "section_applicant", "label_en": "Applicant Information", "type": "section_header" },
    { "key": "applicant_name", "label_en": "Applicant Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "village", "label_en": "Village", "type": "text" },
    { "key": "post_office", "label_en": "Post Office", "type": "text" },
    { "key": "police_station", "label_en": "Police Station", "type": "text" },
    { "key": "district", "label_en": "District", "type": "text" },

    { "key": "section_members", "label_en": "Family Members", "type": "section_header" },
    { "key": "members", "label_en": "Family Members", "type": "repeatable", "subfields": [
      { "key": "Name", "label_en": "Name", "type": "text" },
      { "key": "Relation", "label_en": "Relation", "type": "select", "options": ["MYSELF", "Father", "Mother", "Brother", "Sister", "Spouse", "Son", "Daughter", "Grandfather", "Grandmother", "Uncle", "Aunt", "Other"] },
      { "key": "DOB", "label_en": "Date of Birth", "type": "date" },
      { "key": "PresentAddress", "label_en": "Present Address", "type": "text" },
      { "key": "PermanentAddress", "label_en": "Permanent Address", "type": "text" }
    ]}
  ]'::jsonb,
  true,
  9
FROM agencies
ON CONFLICT DO NOTHING;
