-- Birth Certificate doc type — 3 conditional template types
-- Paurashava, City Corporation, Union Parishad
-- All fields in English only

DELETE FROM doc_types WHERE name = 'Birth Certificate';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Birth Certificate',
  'জন্ম নিবন্ধন',
  'personal',
  '[
    {
      "key": "template_type",
      "label": "সার্টিফিকেটের ধরন",
      "label_en": "Certificate Type",
      "type": "select",
      "required": true,
      "options": ["Paurashava", "City Corporation", "Union Parishad"]
    },

    {
      "key": "section_identity",
      "label": "পরিচয়",
      "label_en": "Identity",
      "type": "section_header"
    },
    {
      "key": "birth_reg_no",
      "label": "জন্ম নিবন্ধন নম্বর",
      "label_en": "Birth Registration Number (17 digits)",
      "type": "text",
      "required": true
    },
    {
      "key": "register_no",
      "label": "রেজিস্টার নম্বর",
      "label_en": "Register Number",
      "type": "text",
      "condition": { "when": "template_type", "not_equals": "Paurashava" }
    },

    {
      "key": "section_personal",
      "label": "ব্যক্তিগত",
      "label_en": "Personal Information",
      "type": "section_header"
    },
    {
      "key": "name_en",
      "label": "নাম",
      "label_en": "Full Name",
      "type": "text",
      "required": true
    },
    {
      "key": "dob",
      "label": "জন্ম তারিখ",
      "label_en": "Date of Birth",
      "type": "date",
      "required": true
    },
    {
      "key": "dob_in_word",
      "label": "জন্ম তারিখ কথায়",
      "label_en": "Date of Birth in Words",
      "type": "text"
    },
    {
      "key": "sex",
      "label": "লিঙ্গ",
      "label_en": "Sex",
      "type": "select",
      "options": ["Male", "Female", "Other"]
    },
    {
      "key": "birth_place",
      "label": "জন্মস্থান",
      "label_en": "Place of Birth",
      "type": "text"
    },

    {
      "key": "section_parents",
      "label": "পিতা-মাতা",
      "label_en": "Parents",
      "type": "section_header"
    },
    {
      "key": "father_name",
      "label": "পিতার নাম",
      "label_en": "Father''s Name",
      "type": "text",
      "required": true
    },
    {
      "key": "father_nationality",
      "label": "পিতার জাতীয়তা",
      "label_en": "Father''s Nationality",
      "type": "text"
    },
    {
      "key": "father_brn",
      "label_en": "Father''s BRN",
      "type": "text"
    },
    {
      "key": "father_nid",
      "label_en": "Father''s NID",
      "type": "text"
    },
    {
      "key": "mother_name",
      "label": "মাতার নাম",
      "label_en": "Mother''s Name",
      "type": "text",
      "required": true
    },
    {
      "key": "mother_nationality",
      "label": "মাতার জাতীয়তা",
      "label_en": "Mother''s Nationality",
      "type": "text"
    },
    {
      "key": "mother_brn",
      "label_en": "Mother''s BRN",
      "type": "text"
    },
    {
      "key": "mother_nid",
      "label_en": "Mother''s NID",
      "type": "text"
    },
    {
      "key": "order_of_child",
      "label_en": "Order of Child",
      "type": "text"
    },

    {
      "key": "section_address",
      "label": "ঠিকানা",
      "label_en": "Address & Registration",
      "type": "section_header"
    },
    {
      "key": "permanent_address",
      "label": "স্থায়ী ঠিকানা",
      "label_en": "Permanent Address",
      "type": "text"
    },
    {
      "key": "reg_date",
      "label": "নিবন্ধনের তারিখ",
      "label_en": "Date of Registration",
      "type": "date"
    },
    {
      "key": "issue_date",
      "label": "ইস্যুর তারিখ",
      "label_en": "Date of Issuance",
      "type": "date"
    },

    {
      "key": "section_authority",
      "label": "কর্তৃপক্ষ",
      "label_en": "Issuing Authority",
      "type": "section_header"
    },
    {
      "key": "paurashava_name",
      "label": "পৌরসভার নাম",
      "label_en": "Paurashava Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "Paurashava" }
    },
    {
      "key": "zone",
      "label": "জোন",
      "label_en": "Zone",
      "type": "text",
      "condition": { "when": "template_type", "equals": "City Corporation" }
    },
    {
      "key": "city_corp_name",
      "label": "সিটি কর্পোরেশন",
      "label_en": "City Corporation Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "City Corporation" }
    },
    {
      "key": "union_name",
      "label": "ইউনিয়ন পরিষদ",
      "label_en": "Union Parishad Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "Union Parishad" }
    },
    {
      "key": "upazila_name",
      "label": "উপজেলা",
      "label_en": "Upazila Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "Union Parishad" }
    },
    {
      "key": "district_name",
      "label": "জেলা",
      "label_en": "District Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "Union Parishad" }
    },
    {
      "key": "section_template",
      "label_en": "Template Fields (auto-generated)",
      "type": "section_header"
    },
    {
      "key": "issuing_line1",
      "label_en": "Issuing Authority Line 1",
      "type": "text"
    },
    {
      "key": "issuing_line2",
      "label_en": "Issuing Authority Line 2",
      "type": "text"
    },
    {
      "key": "issuing_authority",
      "label_en": "Issuing Authority (combined)",
      "type": "text"
    }
  ]'::jsonb,
  true,
  1
FROM agencies
ON CONFLICT DO NOTHING;
