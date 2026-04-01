-- Sponsor document types — TIN Certificate, Income Tax Certificate, Annual Income Certificate
-- Category: sponsor | Japanese translation হবে DocGen template দিয়ে
-- সব sponsor ডকুমেন্ট — OCR parser সাপোর্ট আছে

DELETE FROM doc_types WHERE name IN ('TIN Certificate', 'Income Tax Certificate', 'Annual Income Certificate');

-- ═══════════════════════════════════════════════════════════
-- A) TIN Certificate (টিআইএন সনদ) — sort_order 4
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'TIN Certificate',
  'টিআইএন সনদ',
  'sponsor',
  '[
    { "key": "section_tin", "label_en": "TIN Details", "type": "section_header" },
    { "key": "tin_number", "label_en": "TIN Number", "type": "text", "required": true },
    { "key": "name_en", "label_en": "Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "section_address", "label_en": "Address", "type": "section_header" },
    { "key": "current_address", "label_en": "Current Address", "type": "text" },
    { "key": "permanent_address", "label_en": "Permanent Address", "type": "text" },
    { "key": "section_tax_info", "label_en": "Tax Authority", "type": "section_header" },
    { "key": "taxes_circle", "label_en": "Taxes Circle", "type": "text" },
    { "key": "taxes_zone", "label_en": "Taxes Zone", "type": "text" },
    { "key": "status", "label_en": "Status", "type": "select", "options": ["Individual", "Company", "Firm", "Other"] },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
    { "key": "previous_tin", "label_en": "Previous TIN", "type": "text" }
  ]'::jsonb,
  true,
  4
FROM agencies
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- B) Income Tax Certificate (আয়কর সনদ) — sort_order 5
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Income Tax Certificate',
  'আয়কর সনদ',
  'sponsor',
  '[
    { "key": "section_taxpayer", "label_en": "Taxpayer Information", "type": "section_header" },
    { "key": "etin", "label_en": "e-TIN Number", "type": "text", "required": true },
    { "key": "name_en", "label_en": "Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father/Husband''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "present_address", "label_en": "Present Address", "type": "text" },
    { "key": "permanent_address", "label_en": "Permanent Address", "type": "text" },
    { "key": "status", "label_en": "Status", "type": "select", "options": ["Individual", "Company", "Firm"] },
    { "key": "business_id", "label_en": "Business Identification Number", "type": "text" },
    { "key": "section_tax_payment", "label_en": "Tax Payment Details", "type": "section_header" },
    { "key": "tax_payments", "label_en": "Tax Payments by Year", "type": "repeatable", "subfields": [
      { "key": "Year", "label_en": "Assessment Year", "type": "text" },
      { "key": "Amount", "label_en": "Tax Paid (BDT)", "type": "text" }
    ]},
    { "key": "section_authority", "label_en": "Tax Authority", "type": "section_header" },
    { "key": "taxes_circle", "label_en": "Taxes Circle", "type": "text" },
    { "key": "taxes_zone", "label_en": "Taxes Zone", "type": "text" }
  ]'::jsonb,
  true,
  5
FROM agencies
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- C) Annual Income Certificate (বার্ষিক আয়ের সনদ) — sort_order 6
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Annual Income Certificate',
  'বার্ষিক আয়ের সনদ',
  'sponsor',
  '[
    { "key": "section_person", "label_en": "Personal Information", "type": "section_header" },
    { "key": "name_en", "label_en": "Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father/Husband Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "permanent_address", "label_en": "Permanent Address", "type": "text" },
    { "key": "present_address", "label_en": "Present Address", "type": "text" },
    { "key": "section_income", "label_en": "Annual Income Details", "type": "section_header" },
    { "key": "income_records", "label_en": "Income by Year", "type": "repeatable", "subfields": [
      { "key": "Year", "label_en": "Assessment Year", "type": "text" },
      { "key": "Source", "label_en": "Income Source", "type": "select", "options": ["Business", "Employment", "Property", "Investment", "Agriculture", "Other"] },
      { "key": "Amount", "label_en": "Annual Income (BDT)", "type": "text" }
    ]}
  ]'::jsonb,
  true,
  6
FROM agencies
ON CONFLICT DO NOTHING;
