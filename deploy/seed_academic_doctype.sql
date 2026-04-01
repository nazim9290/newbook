-- SSC ও HSC Certificate doc types — একাডেমিক ট্রান্সক্রিপ্ট
-- উভয়েরই একই ফিল্ড structure: পরীক্ষার তথ্য, শিক্ষার্থী তথ্য, রেজাল্ট, বিষয়ভিত্তিক ফলাফল
-- সব agencies-এর জন্য insert হবে (birth cert seed-এর মতো)

DELETE FROM doc_types WHERE name IN ('SSC Certificate', 'HSC Certificate');

-- ═══════════════════════════════════════════════════════════
-- SSC Certificate — এসএসসি সনদ (sort_order: 2)
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'SSC Certificate',
  'এসএসসি সনদ',
  'academic',
  '[
    {
      "key": "section_exam",
      "label": "পরীক্ষার বিবরণ",
      "label_en": "Examination Details",
      "type": "section_header"
    },
    {
      "key": "board_name",
      "label": "বোর্ডের নাম",
      "label_en": "Board Name",
      "type": "text"
    },
    {
      "key": "exam_year",
      "label": "পরীক্ষার বছর",
      "label_en": "Exam Year",
      "type": "text",
      "required": true
    },
    {
      "key": "serial_no",
      "label": "সিরিয়াল নম্বর",
      "label_en": "Serial No",
      "type": "text"
    },

    {
      "key": "section_student",
      "label": "শিক্ষার্থীর তথ্য",
      "label_en": "Student Information",
      "type": "section_header"
    },
    {
      "key": "name_en",
      "label": "শিক্ষার্থীর নাম",
      "label_en": "Student Name",
      "type": "text",
      "required": true
    },
    {
      "key": "father_name",
      "label": "পিতার নাম",
      "label_en": "Father''s Name",
      "type": "text",
      "required": true
    },
    {
      "key": "mother_name",
      "label": "মাতার নাম",
      "label_en": "Mother''s Name",
      "type": "text"
    },
    {
      "key": "institution",
      "label": "প্রতিষ্ঠানের নাম",
      "label_en": "Institution Name",
      "type": "text"
    },
    {
      "key": "centre",
      "label": "পরীক্ষার কেন্দ্র",
      "label_en": "Exam Centre",
      "type": "text"
    },

    {
      "key": "section_result",
      "label": "ফলাফলের বিবরণ",
      "label_en": "Result Details",
      "type": "section_header"
    },
    {
      "key": "roll_no",
      "label": "রোল নম্বর",
      "label_en": "Roll Number",
      "type": "text",
      "required": true
    },
    {
      "key": "registration_no",
      "label": "রেজিস্ট্রেশন নম্বর",
      "label_en": "Registration Number",
      "type": "text"
    },
    {
      "key": "group",
      "label": "বিভাগ",
      "label_en": "Group",
      "type": "select",
      "options": ["Science", "Commerce", "Arts/Humanities"]
    },
    {
      "key": "student_type",
      "label": "শিক্ষার্থীর ধরন",
      "label_en": "Student Type",
      "type": "select",
      "options": ["Regular", "Irregular", "Private"]
    },
    {
      "key": "gpa",
      "label": "জিপিএ (অতিরিক্ত ছাড়া)",
      "label_en": "GPA (without additional)",
      "type": "text",
      "required": true
    },
    {
      "key": "gpa_with_additional",
      "label": "জিপিএ (অতিরিক্ত বিষয়সহ)",
      "label_en": "GPA (with additional subject)",
      "type": "text"
    },
    {
      "key": "result_date",
      "label": "ফলাফল প্রকাশের তারিখ",
      "label_en": "Date of Publication",
      "type": "text"
    },

    {
      "key": "section_subjects",
      "label": "বিষয়ভিত্তিক ফলাফল",
      "label_en": "Subject Results",
      "type": "section_header"
    },
    {
      "key": "subjects",
      "label": "বিষয়সমূহ",
      "label_en": "Subject Results",
      "type": "repeatable",
      "subfields": [
        { "key": "Subject", "label": "বিষয়", "label_en": "Subject Name", "type": "text" },
        { "key": "Grade", "label": "গ্রেড", "label_en": "Letter Grade", "type": "text" },
        { "key": "Point", "label": "পয়েন্ট", "label_en": "Grade Point", "type": "text" }
      ]
    }
  ]'::jsonb,
  true,
  2
FROM agencies
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- HSC Certificate — এইচএসসি সনদ (sort_order: 3)
-- ═══════════════════════════════════════════════════════════
INSERT INTO doc_types (id, agency_id, name, name_bn, category, fields, is_active, sort_order)
SELECT
  gen_random_uuid(),
  id,
  'HSC Certificate',
  'এইচএসসি সনদ',
  'academic',
  '[
    {
      "key": "section_exam",
      "label": "পরীক্ষার বিবরণ",
      "label_en": "Examination Details",
      "type": "section_header"
    },
    {
      "key": "board_name",
      "label": "বোর্ডের নাম",
      "label_en": "Board Name",
      "type": "text"
    },
    {
      "key": "exam_year",
      "label": "পরীক্ষার বছর",
      "label_en": "Exam Year",
      "type": "text",
      "required": true
    },
    {
      "key": "serial_no",
      "label": "সিরিয়াল নম্বর",
      "label_en": "Serial No",
      "type": "text"
    },

    {
      "key": "section_student",
      "label": "শিক্ষার্থীর তথ্য",
      "label_en": "Student Information",
      "type": "section_header"
    },
    {
      "key": "name_en",
      "label": "শিক্ষার্থীর নাম",
      "label_en": "Student Name",
      "type": "text",
      "required": true
    },
    {
      "key": "father_name",
      "label": "পিতার নাম",
      "label_en": "Father''s Name",
      "type": "text",
      "required": true
    },
    {
      "key": "mother_name",
      "label": "মাতার নাম",
      "label_en": "Mother''s Name",
      "type": "text"
    },
    {
      "key": "institution",
      "label": "প্রতিষ্ঠানের নাম",
      "label_en": "Institution Name",
      "type": "text"
    },
    {
      "key": "centre",
      "label": "পরীক্ষার কেন্দ্র",
      "label_en": "Exam Centre",
      "type": "text"
    },

    {
      "key": "section_result",
      "label": "ফলাফলের বিবরণ",
      "label_en": "Result Details",
      "type": "section_header"
    },
    {
      "key": "roll_no",
      "label": "রোল নম্বর",
      "label_en": "Roll Number",
      "type": "text",
      "required": true
    },
    {
      "key": "registration_no",
      "label": "রেজিস্ট্রেশন নম্বর",
      "label_en": "Registration Number",
      "type": "text"
    },
    {
      "key": "group",
      "label": "বিভাগ",
      "label_en": "Group",
      "type": "select",
      "options": ["Science", "Commerce", "Arts/Humanities"]
    },
    {
      "key": "student_type",
      "label": "শিক্ষার্থীর ধরন",
      "label_en": "Student Type",
      "type": "select",
      "options": ["Regular", "Irregular", "Private"]
    },
    {
      "key": "gpa",
      "label": "জিপিএ (অতিরিক্ত ছাড়া)",
      "label_en": "GPA (without additional)",
      "type": "text",
      "required": true
    },
    {
      "key": "gpa_with_additional",
      "label": "জিপিএ (অতিরিক্ত বিষয়সহ)",
      "label_en": "GPA (with additional subject)",
      "type": "text"
    },
    {
      "key": "result_date",
      "label": "ফলাফল প্রকাশের তারিখ",
      "label_en": "Date of Publication",
      "type": "text"
    },

    {
      "key": "section_subjects",
      "label": "বিষয়ভিত্তিক ফলাফল",
      "label_en": "Subject Results",
      "type": "section_header"
    },
    {
      "key": "subjects",
      "label": "বিষয়সমূহ",
      "label_en": "Subject Results",
      "type": "repeatable",
      "subfields": [
        { "key": "Subject", "label": "বিষয়", "label_en": "Subject Name", "type": "text" },
        { "key": "Grade", "label": "গ্রেড", "label_en": "Letter Grade", "type": "text" },
        { "key": "Point", "label": "পয়েন্ট", "label_en": "Grade Point", "type": "text" }
      ]
    }
  ]'::jsonb,
  true,
  3
FROM agencies
ON CONFLICT DO NOTHING;
