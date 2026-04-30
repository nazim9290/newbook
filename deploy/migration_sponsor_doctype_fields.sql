-- Sponsor doc_types schema update — add missing issuer/issue-date/eTIN fields,
-- and switch year subfields to "fiscal_year" type for dropdown rendering.
--
-- Why UPDATE not DELETE+INSERT: existing document_data rows reference doc_types.id;
-- replacing rows would break the FK on field_data.doc_type_id.
-- This migration preserves IDs and only mutates the `fields` JSONB.

-- ═══════════════════════════════════════════════════════════
-- A) TIN Certificate — add issuer name/office/phone
-- ═══════════════════════════════════════════════════════════
UPDATE doc_types SET fields = '[
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
  { "key": "previous_tin", "label_en": "Previous TIN", "type": "text" },
  { "key": "section_issuer", "label_en": "Issuer Information", "type": "section_header" },
  { "key": "issuer_name", "label_en": "Issuer Name", "type": "text" },
  { "key": "issuer_designation", "label_en": "Issuer Designation", "type": "text" },
  { "key": "issuer_office_address", "label_en": "Issuer Office Address", "type": "text" },
  { "key": "issuer_phone", "label_en": "Issuer Phone", "type": "text" }
]'::jsonb
WHERE name = 'TIN Certificate' AND category = 'sponsor';

-- ═══════════════════════════════════════════════════════════
-- B) Income Tax Certificate — add issue_date + issuer info, year → fiscal_year
-- ═══════════════════════════════════════════════════════════
UPDATE doc_types SET fields = '[
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
    { "key": "Year", "label_en": "Assessment Year", "type": "fiscal_year" },
    { "key": "Amount", "label_en": "Tax Paid (BDT)", "type": "text" }
  ]},
  { "key": "section_authority", "label_en": "Tax Authority", "type": "section_header" },
  { "key": "taxes_circle", "label_en": "Taxes Circle", "type": "text" },
  { "key": "taxes_zone", "label_en": "Taxes Zone", "type": "text" },
  { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
  { "key": "section_issuer", "label_en": "Issuer Information", "type": "section_header" },
  { "key": "issuer_name", "label_en": "Issuer Name", "type": "text" },
  { "key": "issuer_designation", "label_en": "Issuer Designation", "type": "text" },
  { "key": "issuer_phone", "label_en": "Issuer Phone", "type": "text" }
]'::jsonb
WHERE name = 'Income Tax Certificate' AND category = 'sponsor';

-- ═══════════════════════════════════════════════════════════
-- C) Annual Income Certificate — add eTIN/circle/zone/issue/issuer (was missing!)
--    + year → fiscal_year
-- ═══════════════════════════════════════════════════════════
UPDATE doc_types SET fields = '[
  { "key": "section_person", "label_en": "Personal Information", "type": "section_header" },
  { "key": "name_en", "label_en": "Name", "type": "text", "required": true },
  { "key": "father_name", "label_en": "Father/Husband Name", "type": "text" },
  { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
  { "key": "permanent_address", "label_en": "Permanent Address", "type": "text" },
  { "key": "present_address", "label_en": "Present Address", "type": "text" },
  { "key": "etin", "label_en": "e-TIN Number", "type": "text" },
  { "key": "section_income", "label_en": "Annual Income Details", "type": "section_header" },
  { "key": "income_records", "label_en": "Income by Year", "type": "repeatable", "subfields": [
    { "key": "Year", "label_en": "Assessment Year", "type": "fiscal_year" },
    { "key": "Source", "label_en": "Income Source", "type": "select", "options": ["Business", "Employment", "Property", "Investment", "Agriculture", "Other"] },
    { "key": "Amount", "label_en": "Annual Income (BDT)", "type": "text" }
  ]},
  { "key": "section_authority", "label_en": "Tax Authority", "type": "section_header" },
  { "key": "taxes_circle", "label_en": "Taxes Circle", "type": "text" },
  { "key": "taxes_zone", "label_en": "Taxes Zone", "type": "text" },
  { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
  { "key": "section_issuer", "label_en": "Issuer Information", "type": "section_header" },
  { "key": "issuer_name", "label_en": "Issuer Name", "type": "text" },
  { "key": "issuer_designation", "label_en": "Issuer Designation", "type": "text" },
  { "key": "issuer_phone", "label_en": "Issuer Phone", "type": "text" }
]'::jsonb
WHERE name = 'Annual Income Certificate' AND category = 'sponsor';
