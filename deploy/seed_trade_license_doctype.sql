-- Trade License (ট্রেড লাইসেন্স) doc type — E-Trade License / City Corporation
-- Category: sponsor | OCR parser সাপোর্ট আছে

DELETE FROM doc_types WHERE name = 'Trade License';

INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'Trade License',
  'ট্রেড লাইসেন্স',
  'sponsor',
  '[
    { "key": "section_license", "label_en": "License Details", "type": "section_header" },
    { "key": "license_no", "label_en": "License No", "type": "text", "required": true },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
    { "key": "valid_upto", "label_en": "Valid Upto", "type": "date" },
    { "key": "financial_year", "label_en": "Financial Year", "type": "text" },
    { "key": "issuing_authority", "label_en": "Issuing Authority", "type": "text" },

    { "key": "section_business", "label_en": "Business Information", "type": "section_header" },
    { "key": "business_name", "label_en": "Business Name", "type": "text", "required": true },
    { "key": "business_type", "label_en": "Business Type", "type": "text" },
    { "key": "business_category", "label_en": "Business Category", "type": "text" },
    { "key": "business_address", "label_en": "Business Address", "type": "text" },
    { "key": "zone_market", "label_en": "Zone/Market/Area", "type": "text" },
    { "key": "ward_market", "label_en": "Ward/Market", "type": "text" },
    { "key": "bin_no", "label_en": "BIN Number", "type": "text" },

    { "key": "section_owner", "label_en": "Owner Information", "type": "section_header" },
    { "key": "owner_name", "label_en": "Owner''s Name", "type": "text", "required": true },
    { "key": "father_name", "label_en": "Father/Husband''s Name", "type": "text" },
    { "key": "mother_name", "label_en": "Mother''s Name", "type": "text" },
    { "key": "nid_passport", "label_en": "NID/Passport/Birth Reg No", "type": "text" },

    { "key": "section_present_addr", "label_en": "Owner Present Address", "type": "section_header" },
    { "key": "present_holding", "label_en": "Holding No", "type": "text" },
    { "key": "present_road", "label_en": "Road No", "type": "text" },
    { "key": "present_village", "label_en": "Village/Area", "type": "text" },
    { "key": "present_postcode", "label_en": "Postcode", "type": "text" },
    { "key": "present_ps", "label_en": "Police Station", "type": "text" },
    { "key": "present_district", "label_en": "District", "type": "text" },

    { "key": "section_perm_addr", "label_en": "Owner Permanent Address", "type": "section_header" },
    { "key": "perm_holding", "label_en": "Holding No", "type": "text" },
    { "key": "perm_road", "label_en": "Road No", "type": "text" },
    { "key": "perm_village", "label_en": "Village/Area", "type": "text" },
    { "key": "perm_postcode", "label_en": "Postcode", "type": "text" },
    { "key": "perm_ps", "label_en": "Police Station", "type": "text" },
    { "key": "perm_district", "label_en": "District", "type": "text" },

    { "key": "section_fees", "label_en": "Fees & Charges", "type": "section_header" },
    { "key": "fee_items", "label_en": "Fee Breakdown", "type": "repeatable", "subfields": [
      { "key": "Item", "label_en": "Fee Item", "type": "text" },
      { "key": "Amount", "label_en": "Amount (BDT)", "type": "text" }
    ]},
    { "key": "grand_total", "label_en": "Grand Total (BDT)", "type": "text" }
  ]'::jsonb,
  true,
  7
FROM agencies
ON CONFLICT DO NOTHING;
