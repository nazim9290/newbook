-- Bank Statement / Solvency Certificate doc type — sponsor financial proof
-- Category: sponsor | sort_order: 9
--
-- Captures both:
--   1. Bank Statement header (account info, balance, period) — see ref bank statement
--   2. Solvency Certificate fields (issuer, ref no, issue date) — paired document
-- Intentionally does NOT capture transaction lines — just identification + balance.
--
-- Safe to re-run: uses UPDATE-then-INSERT (instead of DELETE+INSERT) so any
-- existing document_data.field_data rows tied to this doc_type are preserved
-- (document_data has ON DELETE CASCADE on doc_type_id).

DO $$
DECLARE
  v_fields JSONB := '[
    { "key": "section_doc", "label_en": "Document Reference", "type": "section_header" },
    { "key": "doc_type", "label_en": "Document Type", "type": "select", "options": ["Bank Statement", "Solvency Certificate", "Both (combined)"] },
    { "key": "ref_no", "label_en": "Reference No", "type": "text" },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
    { "key": "generation_date", "label_en": "Generation Date", "type": "text" },

    { "key": "section_bank", "label_en": "Bank Information", "type": "section_header" },
    { "key": "bank_name", "label_en": "Bank Name", "type": "text", "required": true },
    { "key": "branch", "label_en": "Branch", "type": "text" },

    { "key": "section_account", "label_en": "Account Information", "type": "section_header" },
    { "key": "account_no", "label_en": "Account Number", "type": "text", "required": true },
    { "key": "account_holder_name", "label_en": "Account Holder Name (as in document)", "type": "text" },
    { "key": "account_type", "label_en": "Account Type", "type": "text" },
    { "key": "currency", "label_en": "Currency", "type": "select", "options": ["BDT", "USD", "EUR", "JPY", "GBP", "Other"] },
    { "key": "account_status", "label_en": "Account Status", "type": "select", "options": ["Regular", "Dormant", "Closed", "Frozen"] },
    { "key": "account_open_date", "label_en": "Account Open Date", "type": "date" },

    { "key": "section_holder_addr", "label_en": "Account Holder Address", "type": "section_header" },
    { "key": "address", "label_en": "Address (as in document)", "type": "text" },
    { "key": "city", "label_en": "City", "type": "text" },
    { "key": "phone", "label_en": "Phone", "type": "text" },

    { "key": "section_period", "label_en": "Statement Period", "type": "section_header" },
    { "key": "period_from", "label_en": "From Date", "type": "date" },
    { "key": "period_to", "label_en": "To Date", "type": "date" },

    { "key": "section_balance", "label_en": "Balance Information", "type": "section_header" },
    { "key": "balance", "label_en": "Balance", "type": "text", "required": true },
    { "key": "balance_date", "label_en": "Balance As Of Date", "type": "date" },
    { "key": "balance_in_words", "label_en": "Balance in Words", "type": "text" },

    { "key": "section_solvency", "label_en": "Solvency Statement", "type": "section_header" },
    { "key": "is_solvent", "label_en": "Solvency Certified", "type": "select", "options": ["Yes", "No", "Not Mentioned"] },
    { "key": "solvency_text", "label_en": "Solvency Statement (verbatim)", "type": "text" },

    { "key": "section_issuer", "label_en": "Issuer Information", "type": "section_header" },
    { "key": "issuer_name", "label_en": "Issuer Name", "type": "text" },
    { "key": "issuer_designation", "label_en": "Issuer Designation", "type": "text" },
    { "key": "issuer_office", "label_en": "Issuer Office / Branch", "type": "text" },
    { "key": "issuer_phone", "label_en": "Issuer Phone", "type": "text" }
  ]'::jsonb;
BEGIN
  -- Step 1: normalize name on any pre-existing rows so the UPDATE catches them
  UPDATE doc_types
     SET name = 'Bank Statement'
   WHERE name IN ('ব্যাংক স্টেটমেন্ট', 'bank_statement', 'BankStatement', 'Bank statement');

  -- Step 2: update existing rows (preserves doc_type_id → preserves document_data rows)
  UPDATE doc_types
     SET name_bn    = 'ব্যাংক স্টেটমেন্ট',
         category   = 'sponsor',
         sort_order = 9,
         is_active  = true,
         fields     = v_fields,
         updated_at = now()
   WHERE name = 'Bank Statement';

  -- Step 3: insert for any agency that doesn't have a Bank Statement doc_type yet
  INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
  SELECT gen_random_uuid(), a.id, 'Bank Statement', 'ব্যাংক স্টেটমেন্ট', 'sponsor', v_fields, true, 9
    FROM agencies a
   WHERE NOT EXISTS (
     SELECT 1 FROM doc_types dt
      WHERE dt.agency_id = a.id AND dt.name = 'Bank Statement'
   );
END $$;

-- Verify
SELECT agency_id, name, name_bn, category, sort_order,
       jsonb_array_length(fields) AS field_count
  FROM doc_types
 WHERE name = 'Bank Statement'
 ORDER BY agency_id;
