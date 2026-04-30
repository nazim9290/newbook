-- Bank Statement doc_type — schema upgrade
-- Old format used "name" (not "key") + label only in Bengali, and category was "financial".
-- This puts Bank Statement on equal footing with TIN/Income Tax/Trade License so it can
-- participate in sponsor cross-validation against the sponsor_banks table.
--
-- ⚠️ DEPRECATED — use deploy/seed_bank_statement_doctype.sql instead.
-- This UPDATE-only migration silently no-ops on DBs where the row name was
-- 'ব্যাংক স্টেটমেন্ট' / 'bank_statement' (Bengali UI seed) instead of 'Bank Statement'.
-- The replacement seed file normalises the name + handles missing-row case via INSERT.

UPDATE doc_types SET
  category = 'sponsor',
  fields = '[
    { "key": "section_account", "label_en": "Account Information", "type": "section_header" },
    { "key": "bank_name", "label_en": "Bank Name", "type": "text", "required": true },
    { "key": "branch", "label_en": "Branch", "type": "text" },
    { "key": "account_no", "label_en": "Account Number", "type": "text", "required": true },
    { "key": "account_holder_name", "label_en": "Account Holder Name (in statement)", "type": "text" },
    { "key": "balance", "label_en": "Balance (BDT)", "type": "text" },
    { "key": "balance_date", "label_en": "Balance As Of Date", "type": "date" },
    { "key": "section_holder", "label_en": "Account Holder Address", "type": "section_header" },
    { "key": "address", "label_en": "Address (in statement)", "type": "text" },
    { "key": "section_period", "label_en": "Statement Period", "type": "section_header" },
    { "key": "period_from", "label_en": "From Date", "type": "date" },
    { "key": "period_to", "label_en": "To Date", "type": "date" },
    { "key": "section_issue", "label_en": "Issue Information", "type": "section_header" },
    { "key": "issue_date", "label_en": "Issue Date", "type": "date" },
    { "key": "issuer_name", "label_en": "Issuer / Branch Manager Name", "type": "text" }
  ]'::jsonb
WHERE name = 'Bank Statement';
