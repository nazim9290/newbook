-- জন্ম নিবন্ধন (Birth Certificate) ডকুমেন্ট টাইপ — কন্ডিশনাল ফিল্ড সহ
-- ৩ ধরন: পৌরসভা, সিটি কর্পোরেশন, ইউনিয়ন পরিষদ
-- পৌরসভায় বাংলা ফিল্ড ইংরেজির পাশে বসবে (2-column grid)

-- আগের Birth Certificate doc_type মুছে নতুন করে insert
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
      "options": ["পৌরসভা (Paurashava)", "সিটি কর্পোরেশন (City Corporation)", "ইউনিয়ন পরিষদ (Union Parishad)"]
    },

    {
      "key": "section_identity",
      "label": "পরিচয় তথ্য",
      "type": "section_header"
    },
    {
      "key": "birth_reg_no",
      "label": "জন্ম নিবন্ধন নম্বর (১৭ সংখ্যা)",
      "label_en": "Birth Registration Number",
      "type": "text",
      "required": true
    },
    {
      "key": "register_no",
      "label": "রেজিস্টার নম্বর",
      "label_en": "Register Number",
      "type": "text",
      "condition": { "when": "template_type", "not_equals": "পৌরসভা (Paurashava)" }
    },

    {
      "key": "section_personal",
      "label": "ব্যক্তিগত তথ্য",
      "type": "section_header"
    },
    {
      "key": "name_en",
      "label": "নাম (ইংরেজি)",
      "label_en": "Name (English)",
      "type": "text",
      "required": true
    },
    {
      "key": "name_bn",
      "label": "নাম (বাংলা)",
      "label_en": "Name (Bangla)",
      "type": "text",
      "condition": { "when": "template_type", "equals": "পৌরসভা (Paurashava)" }
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
      "label": "জন্ম তারিখ (কথায়)",
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
      "label": "পিতা-মাতার তথ্য",
      "type": "section_header"
    },
    {
      "key": "father_name",
      "label": "পিতার নাম (ইংরেজি)",
      "label_en": "Father''s Name (English)",
      "type": "text",
      "required": true
    },
    {
      "key": "father_name_bn",
      "label": "পিতার নাম (বাংলা)",
      "label_en": "Father''s Name (Bangla)",
      "type": "text",
      "condition": { "when": "template_type", "equals": "পৌরসভা (Paurashava)" }
    },
    {
      "key": "father_nationality",
      "label": "পিতার জাতীয়তা",
      "label_en": "Father''s Nationality",
      "type": "text"
    },
    {
      "key": "mother_name",
      "label": "মাতার নাম (ইংরেজি)",
      "label_en": "Mother''s Name (English)",
      "type": "text",
      "required": true
    },
    {
      "key": "mother_name_bn",
      "label": "মাতার নাম (বাংলা)",
      "label_en": "Mother''s Name (Bangla)",
      "type": "text",
      "condition": { "when": "template_type", "equals": "পৌরসভা (Paurashava)" }
    },
    {
      "key": "mother_nationality",
      "label": "মাতার জাতীয়তা",
      "label_en": "Mother''s Nationality",
      "type": "text"
    },

    {
      "key": "section_address",
      "label": "ঠিকানা ও নিবন্ধন",
      "type": "section_header"
    },
    {
      "key": "permanent_address",
      "label": "স্থায়ী ঠিকানা (ইংরেজি)",
      "label_en": "Permanent Address (English)",
      "type": "text"
    },
    {
      "key": "permanent_address_bn",
      "label": "স্থায়ী ঠিকানা (বাংলা)",
      "label_en": "Permanent Address (Bangla)",
      "type": "text",
      "condition": { "when": "template_type", "equals": "পৌরসভা (Paurashava)" }
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
      "label": "কর্তৃপক্ষের তথ্য",
      "type": "section_header"
    },
    {
      "key": "paurashava_name",
      "label": "পৌরসভার নাম",
      "label_en": "Paurashava Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "পৌরসভা (Paurashava)" }
    },
    {
      "key": "zone",
      "label": "জোন নম্বর",
      "label_en": "Zone",
      "type": "text",
      "condition": { "when": "template_type", "equals": "সিটি কর্পোরেশন (City Corporation)" }
    },
    {
      "key": "city_corp_name",
      "label": "সিটি কর্পোরেশনের নাম",
      "label_en": "City Corporation Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "সিটি কর্পোরেশন (City Corporation)" }
    },
    {
      "key": "union_name",
      "label": "ইউনিয়ন পরিষদের নাম",
      "label_en": "Union Parishad Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "ইউনিয়ন পরিষদ (Union Parishad)" }
    },
    {
      "key": "upazila_name",
      "label": "উপজেলার নাম",
      "label_en": "Upazila Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "ইউনিয়ন পরিষদ (Union Parishad)" }
    },
    {
      "key": "district_name",
      "label": "জেলার নাম",
      "label_en": "District Name",
      "type": "text",
      "condition": { "when": "template_type", "equals": "ইউনিয়ন পরিষদ (Union Parishad)" }
    }
  ]'::jsonb,
  true,
  1
FROM agencies
ON CONFLICT DO NOTHING;
