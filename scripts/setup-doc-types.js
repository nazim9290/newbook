require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { createClient } = require("@supabase/supabase-js");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const A = "a0000000-0000-0000-0000-000000000001";

async function run() {
  // 1. Create tables
  await s.rpc("exec_sql", { sql_query: `
    CREATE TABLE IF NOT EXISTS doc_types (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_bn TEXT,
      category TEXT DEFAULT 'personal',
      fields JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `}).then(r => console.log("doc_types:", r.data?.error || "OK"));

  await s.rpc("exec_sql", { sql_query: `
    CREATE TABLE IF NOT EXISTS document_data (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL,
      doc_type_id UUID NOT NULL REFERENCES doc_types(id) ON DELETE CASCADE,
      field_data JSONB DEFAULT '{}',
      status TEXT DEFAULT 'draft',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(student_id, doc_type_id)
    )
  `}).then(r => console.log("document_data:", r.data?.error || "OK"));

  // 2. Seed doc types
  const types = [
    { agency_id: A, name: "Birth Certificate", name_bn: "জন্ম সনদ", category: "personal", sort_order: 1,
      fields: [
        { key: "RegistrationBookNo", label: "নিবন্ধন বহি নং", label_en: "Registration Book No", type: "text" },
        { key: "RegistrationDate", label: "নিবন্ধনের তারিখ", label_en: "Registration Date", type: "date" },
        { key: "IssueDate", label: "সনদ ইস্যুর তারিখ", label_en: "Certificate Issue Date", type: "date" },
        { key: "BirthRegNo", label: "জন্ম নিবন্ধন নম্বর", label_en: "Birth Registration No", type: "text" },
        { key: "Name", label: "নাম", label_en: "Name", type: "text" },
        { key: "DOB", label: "জন্ম তারিখ", label_en: "Date of Birth", type: "date" },
        { key: "DOBInWords", label: "জন্ম তারিখ (কথায়)", label_en: "DOB in Words", type: "text" },
        { key: "Gender", label: "লিঙ্গ", label_en: "Gender", type: "select", options: ["Male", "Female", "Other"] },
        { key: "BirthPlace", label: "জন্মস্থান", label_en: "Place of Birth", type: "text" },
        { key: "FatherName", label: "পিতার নাম", label_en: "Father Name", type: "text" },
        { key: "FatherNationality", label: "পিতার জাতীয়তা", label_en: "Father Nationality", type: "text" },
        { key: "MotherName", label: "মাতার নাম", label_en: "Mother Name", type: "text" },
        { key: "MotherNationality", label: "মাতার জাতীয়তা", label_en: "Mother Nationality", type: "text" },
        { key: "Village", label: "গ্রাম", label_en: "Village", type: "text" },
        { key: "UnionName", label: "ইউনিয়ন", label_en: "Union", type: "text" },
        { key: "Upazila", label: "উপজেলা", label_en: "Upazila", type: "text" },
        { key: "District", label: "জেলা", label_en: "District", type: "text" },
      ]
    },
    { agency_id: A, name: "NID Card", name_bn: "জাতীয় পরিচয়পত্র", category: "personal", sort_order: 2,
      fields: [
        { key: "NIDNo", label: "NID নম্বর", label_en: "NID Number", type: "text" },
        { key: "Name", label: "নাম", label_en: "Name", type: "text" },
        { key: "FatherName", label: "পিতার নাম", label_en: "Father Name", type: "text" },
        { key: "MotherName", label: "মাতার নাম", label_en: "Mother Name", type: "text" },
        { key: "DOB", label: "জন্ম তারিখ", label_en: "Date of Birth", type: "date" },
        { key: "BloodGroup", label: "রক্তের গ্রুপ", label_en: "Blood Group", type: "text" },
        { key: "Address", label: "ঠিকানা", label_en: "Address", type: "text" },
        { key: "IssueDate", label: "ইস্যুর তারিখ", label_en: "Issue Date", type: "date" },
      ]
    },
    { agency_id: A, name: "SSC Certificate", name_bn: "এসএসসি সনদ", category: "academic", sort_order: 3,
      fields: [
        { key: "InstituteName", label: "প্রতিষ্ঠান", label_en: "Institute", type: "text" },
        { key: "ExamName", label: "পরীক্ষা", label_en: "Exam", type: "text" },
        { key: "RollNo", label: "রোল", label_en: "Roll", type: "text" },
        { key: "RegNo", label: "রেজি. নং", label_en: "Reg No", type: "text" },
        { key: "Year", label: "সন", label_en: "Year", type: "text" },
        { key: "Board", label: "বোর্ড", label_en: "Board", type: "text" },
        { key: "GPA", label: "জিপিএ", label_en: "GPA", type: "text" },
        { key: "Group", label: "বিভাগ", label_en: "Group", type: "text" },
      ]
    },
    { agency_id: A, name: "HSC Certificate", name_bn: "এইচএসসি সনদ", category: "academic", sort_order: 4,
      fields: [
        { key: "InstituteName", label: "প্রতিষ্ঠান", label_en: "Institute", type: "text" },
        { key: "ExamName", label: "পরীক্ষা", label_en: "Exam", type: "text" },
        { key: "RollNo", label: "রোল", label_en: "Roll", type: "text" },
        { key: "RegNo", label: "রেজি. নং", label_en: "Reg No", type: "text" },
        { key: "Year", label: "সন", label_en: "Year", type: "text" },
        { key: "Board", label: "বোর্ড", label_en: "Board", type: "text" },
        { key: "GPA", label: "জিপিএ", label_en: "GPA", type: "text" },
        { key: "Group", label: "বিভাগ", label_en: "Group", type: "text" },
      ]
    },
    { agency_id: A, name: "Passport", name_bn: "পাসপোর্ট", category: "personal", sort_order: 5,
      fields: [
        { key: "PassportNo", label: "পাসপোর্ট নম্বর", label_en: "Passport No", type: "text" },
        { key: "Name", label: "নাম", label_en: "Name", type: "text" },
        { key: "Surname", label: "পদবি", label_en: "Surname", type: "text" },
        { key: "DOB", label: "জন্ম তারিখ", label_en: "DOB", type: "date" },
        { key: "Gender", label: "লিঙ্গ", label_en: "Gender", type: "text" },
        { key: "BirthPlace", label: "জন্মস্থান", label_en: "Birth Place", type: "text" },
        { key: "IssueDate", label: "ইস্যু", label_en: "Issue Date", type: "date" },
        { key: "ExpiryDate", label: "মেয়াদ", label_en: "Expiry", type: "date" },
        { key: "IssuePlace", label: "ইস্যুর স্থান", label_en: "Issue Place", type: "text" },
      ]
    },
    { agency_id: A, name: "Family Certificate", name_bn: "পারিবারিক সনদ", category: "personal", sort_order: 6,
      fields: [
        { key: "CertificateNo", label: "সনদ নম্বর", label_en: "Certificate No", type: "text" },
        { key: "HeadName", label: "পরিবার প্রধান", label_en: "Family Head", type: "text" },
        { key: "Address", label: "ঠিকানা", label_en: "Address", type: "text" },
        { key: "MemberCount", label: "সদস্য সংখ্যা", label_en: "Members", type: "text" },
        { key: "IssueDate", label: "ইস্যু তারিখ", label_en: "Issue Date", type: "date" },
        { key: "IssuedBy", label: "ইস্যুকারী", label_en: "Issued By", type: "text" },
      ]
    },
  ];

  for (const dt of types) {
    const { error } = await s.from("doc_types").insert(dt);
    if (error && error.message.includes("duplicate")) console.log(dt.name, "- exists");
    else if (error) console.log(dt.name, "ERROR:", error.message);
    else console.log(dt.name, "- created");
  }

  // Verify
  const { data } = await s.from("doc_types").select("name, name_bn, category").order("sort_order");
  console.log("\nAll doc types:");
  (data || []).forEach(d => console.log(`  ${d.name} (${d.name_bn}) — ${d.category}`));
}

run();
