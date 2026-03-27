-- AgencyBook Student Portal — Schema additions

-- Students table-এ portal fields যোগ
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_password_hash TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_access BOOLEAN DEFAULT false;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_email TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS portal_sections JSONB DEFAULT '[]';
ALTER TABLE students ADD COLUMN IF NOT EXISTS last_portal_login TIMESTAMPTZ;

-- Portal form config table — Admin কোন কোন ফর্ম student দেখতে/edit করতে পারবে
CREATE TABLE IF NOT EXISTS portal_form_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id),
  section_key TEXT NOT NULL,
  section_label TEXT NOT NULL,
  section_label_bn TEXT,
  fields JSONB DEFAULT '[]',
  is_enabled BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Default form sections
INSERT INTO portal_form_config (agency_id, section_key, section_label, section_label_bn, fields, is_enabled, sort_order)
SELECT 'a0000000-0000-0000-0000-000000000001', v.section_key, v.section_label, v.section_label_bn, v.fields::jsonb, true, v.sort_order
FROM (VALUES
  ('personal', 'Personal Information', 'ব্যক্তিগত তথ্য',
   '[{"key":"name_en","label":"নাম (English)","type":"text","required":true},{"key":"name_bn","label":"নাম (বাংলা)","type":"text","required":true},{"key":"phone","label":"ফোন","type":"text","required":true},{"key":"whatsapp","label":"WhatsApp","type":"text"},{"key":"email","label":"ইমেইল","type":"email"},{"key":"dob","label":"জন্ম তারিখ","type":"date","required":true},{"key":"gender","label":"লিঙ্গ","type":"select","options":["Male","Female","Other"]},{"key":"marital_status","label":"বৈবাহিক অবস্থা","type":"select","options":["Single","Married","Divorced","Widowed"]},{"key":"nationality","label":"জাতীয়তা","type":"text"},{"key":"blood_group","label":"রক্তের গ্রুপ","type":"select","options":["A+","A-","B+","B-","AB+","AB-","O+","O-"]}]', 1),
  ('identity', 'Identity & Passport', 'পরিচয়পত্র ও পাসপোর্ট',
   '[{"key":"nid","label":"NID নম্বর","type":"text"},{"key":"passport_number","label":"পাসপোর্ট নম্বর","type":"text","required":true},{"key":"passport_issue","label":"ইস্যু তারিখ","type":"date"},{"key":"passport_expiry","label":"মেয়াদ শেষ","type":"date","required":true}]', 2),
  ('address', 'Address', 'ঠিকানা',
   '[{"key":"permanent_address","label":"স্থায়ী ঠিকানা","type":"textarea","required":true},{"key":"current_address","label":"বর্তমান ঠিকানা","type":"textarea"}]', 3),
  ('family', 'Family Information', 'পারিবারিক তথ্য',
   '[{"key":"father_name","label":"পিতার নাম (বাংলা)","type":"text","required":true},{"key":"father_name_en","label":"পিতার নাম (English)","type":"text","required":true},{"key":"mother_name","label":"মাতার নাম (বাংলা)","type":"text","required":true},{"key":"mother_name_en","label":"মাতার নাম (English)","type":"text","required":true}]', 4),
  ('education', 'Education History', 'শিক্ষাগত যোগ্যতা', '[]', 5),
  ('jp_exam', 'Japanese Exam', 'জাপানি ভাষা পরীক্ষা', '[]', 6)
) AS v(section_key, section_label, section_label_bn, fields, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM portal_form_config WHERE section_key = v.section_key);
