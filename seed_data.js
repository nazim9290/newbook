require("dotenv").config({ path: __dirname + "/.env" });
const { createClient } = require("@supabase/supabase-js");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const A = "a0000000-0000-0000-0000-000000000001";

async function seed() {
  console.log("Seeding realistic data...\n");

  // ============ VISITORS (8) ============
  const { error: vErr } = await s.from("visitors").insert([
    { agency_id:A, name:"Rahim Uddin", name_bn:"রহিম উদ্দিন", phone:"01711111111", email:"rahim@gmail.com", dob:"2000-05-15", gender:"Male", source:"Facebook", counselor:"Mina", status:"interested", interested_countries:["Japan"], interested_intake:"April 2026", visit_date:"2026-03-10", branch:"Main" },
    { agency_id:A, name:"Karim Hasan", name_bn:"করিম হাসান", phone:"01722222222", email:"karim@gmail.com", dob:"1999-08-20", gender:"Male", source:"Walk-in", counselor:"Sadia", status:"thinking", interested_countries:["Japan"], interested_intake:"October 2026", visit_date:"2026-03-12", branch:"Main" },
    { agency_id:A, name:"Nasrin Akter", name_bn:"নাসরিন আক্তার", phone:"01733333333", gender:"Female", source:"Agent", status:"interested", interested_countries:["Japan","Germany"], visit_date:"2026-03-15", branch:"Main" },
    { agency_id:A, name:"Sohel Rana", name_bn:"সোহেল রানা", phone:"01744444444", gender:"Male", source:"Referral", status:"new", interested_countries:["Japan"], visit_date:"2026-03-20", branch:"Main" },
    { agency_id:A, name:"Tania Islam", name_bn:"তানিয়া ইসলাম", phone:"01755555555", gender:"Female", source:"Facebook", status:"contacted", interested_countries:["Japan"], visit_date:"2026-03-18", branch:"Main" },
    { agency_id:A, name:"Mizanur Rahman", name_bn:"মিজানুর রহমান", phone:"01766666666", gender:"Male", source:"YouTube", status:"follow_up", interested_countries:["Japan"], visit_date:"2026-03-05", branch:"Main", next_follow_up:"2026-03-25" },
    { agency_id:A, name:"Farhana Begum", name_bn:"ফারহানা বেগম", phone:"01777777777", gender:"Female", source:"Walk-in", status:"not_interested", interested_countries:["Germany"], visit_date:"2026-02-28", branch:"Main" },
    { agency_id:A, name:"Abu Saeed", name_bn:"আবু সাঈদ", phone:"01788888888", gender:"Male", source:"Facebook", status:"interested", interested_countries:["Japan"], visit_date:"2026-03-22", branch:"Main" },
  ]);
  console.log("Visitors:", vErr ? "ERROR: " + vErr.message : "8 inserted");

  // ============ Get school/batch IDs ============
  const { data: schoolsData } = await s.from("schools").select("id, name_en");
  const { data: batchesData } = await s.from("batches").select("id, name");
  const { data: agentsData } = await s.from("agents").select("id, name");
  const school1 = schoolsData?.[0]?.id;
  const school2 = schoolsData?.[1]?.id;
  const batch1 = batchesData?.[0]?.id;
  const batch2 = batchesData?.[1]?.id;
  const agent1 = agentsData?.[0]?.id;
  const agent2 = agentsData?.[1]?.id;

  // ============ STUDENTS (10) ============
  const { error: sErr } = await s.from("students").insert([
    { id:"S-2026-001", agency_id:A, name_en:"Mohammad Rahim", name_bn:"মোহাম্মদ রহিম", name_katakana:"モハマド ラヒム", phone:"01811111111", email:"rahim.s@gmail.com", dob:"1998-03-12", gender:"Male", nationality:"Bangladeshi", nid:"1998123456789", passport_number:"BK1234567", passport_issue:"2023-03-01", passport_expiry:"2033-03-01", permanent_address:"Comilla Sadar, Comilla", current_address:"Mirpur-10, Dhaka", father_name:"আব্দুল করিম", father_name_en:"Abdul Karim", mother_name:"ফাতেমা বেগম", mother_name_en:"Fatema Begum", status:"IN_COURSE", country:"Japan", school_id:school1, batch_id:batch1, intake:"April 2026", source:"Facebook", student_type:"own", branch:"Main", blood_group:"B+" },
    { id:"S-2026-002", agency_id:A, name_en:"Nasrin Sultana", name_bn:"নাসরিন সুলতানা", phone:"01822222222", dob:"1999-07-25", gender:"Female", passport_number:"BM2345678", passport_expiry:"2034-07-25", permanent_address:"Sylhet Sadar, Sylhet", father_name:"হাসান আলী", mother_name:"রেহানা বেগম", status:"DOC_COLLECTION", country:"Japan", school_id:school1, batch_id:batch1, intake:"April 2026", source:"Agent", agent_id:agent1, student_type:"agent", branch:"Main", blood_group:"A+" },
    { id:"S-2026-003", agency_id:A, name_en:"Habibur Rahman", name_bn:"হাবিবুর রহমান", phone:"01833333333", dob:"1997-11-03", gender:"Male", passport_number:"BN3456789", permanent_address:"Chattogram Sadar", father_name:"মোজাম্মেল হক", mother_name:"আয়েশা খাতুন", status:"ENROLLED", country:"Japan", batch_id:batch2, intake:"October 2026", source:"Walk-in", student_type:"own", branch:"Main", blood_group:"O+" },
    { id:"S-2026-004", agency_id:A, name_en:"Sadia Akter", name_bn:"সাদিয়া আক্তার", phone:"01844444444", dob:"2000-01-18", gender:"Female", passport_number:"BP4567890", permanent_address:"Rajshahi Sadar", father_name:"আনোয়ার হোসেন", mother_name:"সালমা বেগম", status:"VISA_GRANTED", country:"Japan", school_id:school2, batch_id:batch1, intake:"April 2026", source:"Referral", student_type:"own", branch:"Main" },
    { id:"S-2026-005", agency_id:A, name_en:"Rafiqul Islam", name_bn:"রফিকুল ইসলাম", phone:"01855555555", dob:"1998-09-07", gender:"Male", passport_number:"BQ5678901", permanent_address:"Khulna Sadar", father_name:"আলী আকবর", mother_name:"জাহানারা বেগম", status:"EXAM_PASSED", country:"Japan", batch_id:batch1, intake:"April 2026", source:"Facebook", student_type:"own", branch:"Main" },
    { id:"S-2026-006", agency_id:A, name_en:"Sohel Rana", name_bn:"সোহেল রানা", phone:"01866666666", dob:"1999-04-22", gender:"Male", passport_number:"BR6789012", permanent_address:"Barishal Sadar", father_name:"মকবুল হোসেন", mother_name:"মরিয়ম বেগম", status:"COE_RECEIVED", country:"Japan", school_id:school1, batch_id:batch1, intake:"April 2026", source:"Agent", agent_id:agent2, student_type:"agent", branch:"Main" },
    { id:"S-2026-007", agency_id:A, name_en:"Tahmina Begum", name_bn:"তাহমিনা বেগম", phone:"01877777777", dob:"2001-02-14", gender:"Female", passport_number:"BS7890123", permanent_address:"Rangpur Sadar", father_name:"জহুরুল হক", mother_name:"নূরজাহান বেগম", status:"SCHOOL_INTERVIEW", country:"Japan", school_id:school2, batch_id:batch2, intake:"October 2026", source:"Walk-in", student_type:"own", branch:"Main" },
    { id:"S-2026-008", agency_id:A, name_en:"Mizanur Rahman", name_bn:"মিজানুর রহমান", phone:"01888888888", dob:"1997-06-30", gender:"Male", passport_number:"BT8901234", permanent_address:"Mymensingh Sadar", father_name:"আব্দুর রশিদ", mother_name:"হালিমা বেগম", status:"DOC_SUBMITTED", country:"Japan", school_id:school1, batch_id:batch1, intake:"April 2026", source:"Facebook", student_type:"own", branch:"Main" },
    { id:"S-2026-009", agency_id:A, name_en:"Farhana Islam", name_bn:"ফারহানা ইসলাম", phone:"01899999999", dob:"2000-12-05", gender:"Female", passport_number:"BU9012345", permanent_address:"Gazipur Sadar", father_name:"শফিকুল ইসলাম", mother_name:"রুবিনা আক্তার", status:"ARRIVED", country:"Japan", school_id:school2, batch_id:batch1, intake:"April 2026", source:"Agent", agent_id:agent1, student_type:"agent", branch:"Main" },
    { id:"S-2026-010", agency_id:A, name_en:"Kamrul Hasan", name_bn:"কামরুল হাসান", phone:"01900000000", dob:"1998-08-19", gender:"Male", passport_number:"BV0123456", permanent_address:"Narayanganj Sadar", father_name:"নূরুল হাসান", mother_name:"শামীমা বেগম", status:"CANCELLED", country:"Japan", intake:"April 2026", source:"Walk-in", student_type:"own", branch:"Main" },
  ]);
  console.log("Students:", sErr ? "ERROR: " + sErr.message : "10 inserted");

  // ============ STUDENT EDUCATION ============
  const { error: eErr } = await s.from("student_education").insert([
    { student_id:"S-2026-001", level:"SSC", school_name:"Comilla Zilla School", year:"2014", board:"Comilla", gpa:"4.50", subject_group:"Science" },
    { student_id:"S-2026-001", level:"HSC", school_name:"Comilla Victoria College", year:"2016", board:"Comilla", gpa:"4.00", subject_group:"Science" },
    { student_id:"S-2026-001", level:"Honours", school_name:"Dhaka University", year:"2020", board:"", gpa:"3.20", subject_group:"Economics" },
    { student_id:"S-2026-002", level:"SSC", school_name:"Sylhet Govt Girls School", year:"2015", board:"Sylhet", gpa:"5.00", subject_group:"Science" },
    { student_id:"S-2026-002", level:"HSC", school_name:"MC College Sylhet", year:"2017", board:"Sylhet", gpa:"4.75", subject_group:"Science" },
    { student_id:"S-2026-003", level:"SSC", school_name:"Chittagong Collegiate", year:"2013", board:"Chittagong", gpa:"4.00", subject_group:"Commerce" },
    { student_id:"S-2026-003", level:"HSC", school_name:"Chittagong College", year:"2015", board:"Chittagong", gpa:"3.50", subject_group:"Commerce" },
    { student_id:"S-2026-004", level:"SSC", school_name:"Rajshahi Collegiate", year:"2016", board:"Rajshahi", gpa:"4.80", subject_group:"Science" },
    { student_id:"S-2026-004", level:"HSC", school_name:"Rajshahi College", year:"2018", board:"Rajshahi", gpa:"4.50", subject_group:"Science" },
    { student_id:"S-2026-005", level:"SSC", school_name:"Khulna Zilla School", year:"2014", board:"Khulna", gpa:"4.25", subject_group:"Science" },
    { student_id:"S-2026-005", level:"HSC", school_name:"BL College Khulna", year:"2016", board:"Khulna", gpa:"3.80", subject_group:"Science" },
  ]);
  console.log("Education:", eErr ? "ERROR: " + eErr.message : "11 inserted");

  // ============ STUDENT JP EXAMS ============
  const { error: jErr } = await s.from("student_jp_exams").insert([
    { student_id:"S-2026-001", exam_type:"JLPT", level:"N5", exam_date:"2025-12-01", score:"120", result:"pass" },
    { student_id:"S-2026-002", exam_type:"NAT", level:"N5", exam_date:"2025-11-15", score:"95", result:"pass" },
    { student_id:"S-2026-004", exam_type:"JLPT", level:"N4", exam_date:"2025-12-01", score:"140", result:"pass" },
    { student_id:"S-2026-005", exam_type:"JLPT", level:"N5", exam_date:"2025-12-01", score:"110", result:"pass" },
    { student_id:"S-2026-006", exam_type:"NAT", level:"N5", exam_date:"2025-10-20", score:"88", result:"pass" },
    { student_id:"S-2026-009", exam_type:"JLPT", level:"N4", exam_date:"2025-07-01", score:"135", result:"pass" },
  ]);
  console.log("JP Exams:", jErr ? "ERROR: " + jErr.message : "6 inserted");

  // ============ SPONSORS ============
  const { error: spErr } = await s.from("sponsors").insert([
    { student_id:"S-2026-001", name:"আব্দুল করিম", name_en:"Abdul Karim", relationship:"Father", phone:"01711000001", address:"Comilla Sadar", company_name:"Karim Traders", annual_income_y1:500000, annual_income_y2:550000, annual_income_y3:600000, tax_y1:15000, tax_y2:17000, tax_y3:20000, tuition_jpy:780000, living_jpy_monthly:80000 },
    { student_id:"S-2026-002", name:"হাসান আলী", name_en:"Hasan Ali", relationship:"Father", phone:"01722000002", address:"Sylhet Sadar", company_name:"Ali Enterprise", annual_income_y1:700000, annual_income_y2:750000, annual_income_y3:800000, tax_y1:25000, tax_y2:28000, tax_y3:32000, tuition_jpy:780000, living_jpy_monthly:80000 },
    { student_id:"S-2026-004", name:"আনোয়ার হোসেন", name_en:"Anowar Hossain", relationship:"Father", phone:"01744000004", address:"Rajshahi Sadar", annual_income_y1:450000, annual_income_y2:480000, annual_income_y3:520000, tax_y1:12000, tax_y2:14000, tax_y3:16000, tuition_jpy:720000, living_jpy_monthly:70000 },
  ]);
  console.log("Sponsors:", spErr ? "ERROR: " + spErr.message : "3 inserted");

  // ============ BATCH STUDENTS ============
  const { error: bsErr } = await s.from("batch_students").insert([
    { batch_id:batch1, student_id:"S-2026-001" },
    { batch_id:batch1, student_id:"S-2026-002" },
    { batch_id:batch1, student_id:"S-2026-004" },
    { batch_id:batch1, student_id:"S-2026-005" },
    { batch_id:batch1, student_id:"S-2026-006" },
    { batch_id:batch1, student_id:"S-2026-008" },
    { batch_id:batch2, student_id:"S-2026-003" },
    { batch_id:batch2, student_id:"S-2026-007" },
  ]);
  console.log("Batch Students:", bsErr ? "ERROR: " + bsErr.message : "8 inserted");

  // ============ PAYMENTS ============
  const { error: pErr } = await s.from("payments").insert([
    { agency_id:A, student_id:"S-2026-001", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:15000, status:"paid", payment_method:"bKash", date:"2025-12-15" },
    { agency_id:A, student_id:"S-2026-001", category:"course_fee", label:"কোর্স ফি", total_amount:25000, paid_amount:15000, installments:3, paid_installments:2, status:"partial", payment_method:"Cash", date:"2026-01-10" },
    { agency_id:A, student_id:"S-2026-001", category:"doc_processing", label:"ডকুমেন্ট প্রসেসিং", total_amount:20000, paid_amount:20000, status:"paid", payment_method:"Bank Transfer", date:"2026-02-01" },
    { agency_id:A, student_id:"S-2026-002", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:15000, status:"paid", payment_method:"Cash", date:"2025-12-20" },
    { agency_id:A, student_id:"S-2026-002", category:"service_charge", label:"সার্ভিস চার্জ", total_amount:50000, paid_amount:30000, installments:5, paid_installments:3, status:"partial", payment_method:"bKash", date:"2026-01-15" },
    { agency_id:A, student_id:"S-2026-003", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:0, status:"pending", due_date:"2026-04-01" },
    { agency_id:A, student_id:"S-2026-004", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:15000, status:"paid", payment_method:"Cash", date:"2025-11-01" },
    { agency_id:A, student_id:"S-2026-004", category:"visa_fee", label:"ভিসা ফি", total_amount:35000, paid_amount:35000, status:"paid", payment_method:"Bank Transfer", date:"2026-02-20" },
    { agency_id:A, student_id:"S-2026-004", category:"shoukai_fee", label:"紹介費 (Shoukai Fee)", total_amount:80000, paid_amount:80000, status:"paid", payment_method:"Bank Transfer", date:"2026-03-01" },
    { agency_id:A, student_id:"S-2026-006", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:15000, status:"paid", payment_method:"Nagad", date:"2025-12-10" },
    { agency_id:A, student_id:"S-2026-006", category:"service_charge", label:"সার্ভিস চার্জ", total_amount:50000, paid_amount:50000, status:"paid", payment_method:"Cash", date:"2026-01-20" },
    { agency_id:A, student_id:"S-2026-009", category:"enrollment_fee", label:"ভর্তি ফি", total_amount:15000, paid_amount:15000, status:"paid", payment_method:"Cash", date:"2025-10-01" },
  ]);
  console.log("Payments:", pErr ? "ERROR: " + pErr.message : "12 inserted");

  // ============ EXPENSES ============
  const { error: exErr } = await s.from("expenses").insert([
    { agency_id:A, category:"rent", description:"অফিস ভাড়া — মার্চ ২০২৬", amount:35000, date:"2026-03-01", branch:"Main" },
    { agency_id:A, category:"salary", description:"স্টাফ বেতন — মার্চ", amount:120000, date:"2026-03-05", branch:"Main" },
    { agency_id:A, category:"utility", description:"বিদ্যুৎ + ইন্টারনেট", amount:8500, date:"2026-03-10", branch:"Main" },
    { agency_id:A, category:"marketing", description:"Facebook Ads — মার্চ", amount:15000, date:"2026-03-01", branch:"Main" },
    { agency_id:A, category:"supplies", description:"অফিস সাপ্লাই (কাগজ, কালি)", amount:3500, date:"2026-03-15", branch:"Main" },
    { agency_id:A, category:"travel", description:"জাপান দূতাবাস ভিজিট", amount:5000, date:"2026-03-12", branch:"Main" },
  ]);
  console.log("Expenses:", exErr ? "ERROR: " + exErr.message : "6 inserted");

  // ============ EMPLOYEES ============
  const { error: emErr } = await s.from("employees").insert([
    { agency_id:A, name:"মিনা আক্তার", designation:"Senior Counselor", department:"Counseling", phone:"01611111111", salary:25000, branch:"Main", join_date:"2024-01-15", status:"active" },
    { agency_id:A, name:"সাদিয়া রহমান", designation:"Counselor", department:"Counseling", phone:"01622222222", salary:20000, branch:"Main", join_date:"2024-06-01", status:"active" },
    { agency_id:A, name:"করিম উদ্দিন", designation:"Document Officer", department:"Documents", phone:"01633333333", salary:22000, branch:"Main", join_date:"2025-01-10", status:"active" },
    { agency_id:A, name:"রাফি আহমেদ", designation:"Accountant", department:"Finance", phone:"01644444444", salary:28000, branch:"Main", join_date:"2024-03-01", status:"active" },
  ]);
  console.log("Employees:", emErr ? "ERROR: " + emErr.message : "4 inserted");

  // ============ TASKS ============
  const { error: tErr } = await s.from("tasks").insert([
    { agency_id:A, title:"S-2026-002 এর NID কালেক্ট করুন", description:"Nasrin এর NID original + photocopy দরকার", priority:"high", status:"pending", student_id:"S-2026-002", due_date:"2026-03-28" },
    { agency_id:A, title:"Tokyo Galaxy তে submission পাঠান", description:"S-2026-008 এর ডকুমেন্ট সাবমিশন", priority:"urgent", status:"in_progress", student_id:"S-2026-008", due_date:"2026-03-25" },
    { agency_id:A, title:"Sadia এর air ticket বুক করুন", priority:"medium", status:"pending", student_id:"S-2026-004", due_date:"2026-04-10" },
    { agency_id:A, title:"মার্চের হিসাব চূড়ান্ত করুন", priority:"low", status:"pending", due_date:"2026-03-31" },
  ]);
  console.log("Tasks:", tErr ? "ERROR: " + tErr.message : "4 inserted");

  // ============ ATTENDANCE ============
  const attRecords = [];
  const dates = ["2026-03-20", "2026-03-21", "2026-03-22", "2026-03-23"];
  const attStudents = ["S-2026-001","S-2026-002","S-2026-004","S-2026-005","S-2026-006","S-2026-008"];
  for (const date of dates) {
    for (const sid of attStudents) {
      const rand = Math.random();
      attRecords.push({ agency_id:A, batch_id:batch1, student_id:sid, date, status: rand > 0.85 ? "absent" : rand > 0.7 ? "late" : "present" });
    }
  }
  const { error: aErr } = await s.from("attendance").insert(attRecords);
  console.log("Attendance:", aErr ? "ERROR: " + aErr.message : attRecords.length + " inserted");

  // ============ COMMUNICATIONS ============
  const { error: cErr } = await s.from("communications").insert([
    { agency_id:A, student_id:"S-2026-001", type:"call", direction:"outgoing", notes:"কোর্স প্রোগ্রেস নিয়ে আলোচনা, N5 পাস করেছে", follow_up_date:"2026-03-30" },
    { agency_id:A, student_id:"S-2026-002", type:"whatsapp", direction:"outgoing", notes:"NID original আনতে বলা হয়েছে", follow_up_date:"2026-03-26" },
    { agency_id:A, student_id:"S-2026-004", type:"call", direction:"incoming", notes:"Visa পেয়েছে, ticket booking নিয়ে জানতে চায়" },
    { agency_id:A, visitor_id: null, type:"meeting", direction:"outgoing", subject:"Japan Embassy Meeting", notes:"ভিসা প্রসেসিং নিয়ে দূতাবাসে মিটিং" },
  ]);
  console.log("Communications:", cErr ? "ERROR: " + cErr.message : "4 inserted");

  // ============ CALENDAR EVENTS ============
  const { error: ceErr } = await s.from("calendar_events").insert([
    { agency_id:A, title:"JLPT N5 পরীক্ষা", date:"2026-07-01", time:"10:00", type:"exam", description:"Batch April 2026 এর JLPT N5 পরীক্ষা" },
    { agency_id:A, title:"Tokyo Galaxy Interview", date:"2026-03-28", time:"14:00", type:"interview", student_id:"S-2026-007", description:"Online interview — Zoom link পাঠানো হয়েছে" },
    { agency_id:A, title:"Osaka YMCA Deadline", date:"2026-04-15", type:"deadline", description:"October 2026 intake submission deadline" },
    { agency_id:A, title:"স্টাফ মিটিং", date:"2026-03-25", time:"09:00", type:"meeting", description:"সাপ্তাহিক প্রোগ্রেস রিভিউ" },
    { agency_id:A, title:"Sadia — Flight", date:"2026-04-12", time:"23:55", type:"general", student_id:"S-2026-004", description:"Biman BG-456 Dhaka→Tokyo Narita" },
  ]);
  console.log("Calendar:", ceErr ? "ERROR: " + ceErr.message : "5 inserted");

  // ============ DOCUMENTS ============
  const { error: dErr } = await s.from("documents").insert([
    { student_id:"S-2026-001", agency_id:A, doc_type:"passport", label:"পাসপোর্ট", status:"verified" },
    { student_id:"S-2026-001", agency_id:A, doc_type:"nid", label:"NID", status:"verified" },
    { student_id:"S-2026-001", agency_id:A, doc_type:"ssc_certificate", label:"SSC সনদপত্র", status:"verified" },
    { student_id:"S-2026-001", agency_id:A, doc_type:"hsc_certificate", label:"HSC সনদপত্র", status:"verified" },
    { student_id:"S-2026-001", agency_id:A, doc_type:"bank_statement", label:"ব্যাংক স্টেটমেন্ট", status:"submitted" },
    { student_id:"S-2026-001", agency_id:A, doc_type:"photo", label:"পাসপোর্ট সাইজ ছবি", status:"collected" },
    { student_id:"S-2026-002", agency_id:A, doc_type:"passport", label:"পাসপোর্ট", status:"collected" },
    { student_id:"S-2026-002", agency_id:A, doc_type:"nid", label:"NID", status:"pending" },
    { student_id:"S-2026-002", agency_id:A, doc_type:"ssc_certificate", label:"SSC সনদপত্র", status:"collected" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"passport", label:"পাসপোর্ট", status:"verified" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"nid", label:"NID", status:"verified" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"ssc_certificate", label:"SSC সনদপত্র", status:"verified" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"hsc_certificate", label:"HSC সনদপত্র", status:"verified" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"bank_statement", label:"ব্যাংক স্টেটমেন্ট", status:"verified" },
    { student_id:"S-2026-004", agency_id:A, doc_type:"coe", label:"COE (在留資格認定証明書)", status:"verified" },
  ]);
  console.log("Documents:", dErr ? "ERROR: " + dErr.message : "15 inserted");

  // ============ SUBMISSIONS ============
  const { error: subErr } = await s.from("submissions").insert([
    { agency_id:A, school_id:school1, student_id:"S-2026-001", submission_number:"TG-2026-001", intake:"April 2026", status:"accepted", submission_date:"2026-01-15", result_date:"2026-02-10" },
    { agency_id:A, school_id:school1, student_id:"S-2026-006", submission_number:"TG-2026-002", intake:"April 2026", status:"accepted", submission_date:"2026-01-15", result_date:"2026-02-10" },
    { agency_id:A, school_id:school1, student_id:"S-2026-008", submission_number:"TG-2026-003", intake:"April 2026", status:"pending", submission_date:"2026-03-10" },
    { agency_id:A, school_id:school2, student_id:"S-2026-004", submission_number:"OM-2026-001", intake:"April 2026", status:"accepted", submission_date:"2025-12-20", result_date:"2026-01-15" },
    { agency_id:A, school_id:school2, student_id:"S-2026-007", submission_number:"OM-2026-002", intake:"October 2026", status:"interview", submission_date:"2026-03-01", interview_date:"2026-03-28" },
  ]);
  console.log("Submissions:", subErr ? "ERROR: " + subErr.message : "5 inserted");

  // ============ INVENTORY ============
  const { error: iErr } = await s.from("inventory").insert([
    { agency_id:A, name:"A4 Paper (Ream)", category:"Office Supply", quantity:25, unit_price:450, branch:"Main" },
    { agency_id:A, name:"Printer Ink (Black)", category:"Office Supply", quantity:5, unit_price:1200, branch:"Main" },
    { agency_id:A, name:"File Folder", category:"Office Supply", quantity:100, unit_price:35, branch:"Main" },
    { agency_id:A, name:"Laptop (Staff)", category:"Equipment", quantity:3, unit_price:55000, branch:"Main" },
    { agency_id:A, name:"Whiteboard Marker", category:"Classroom", quantity:20, unit_price:80, branch:"Main" },
  ]);
  console.log("Inventory:", iErr ? "ERROR: " + iErr.message : "5 inserted");

  // ============ FINAL CHECK ============
  console.log("\n=== FINAL COUNT ===");
  const tables = ["agencies","users","visitors","agents","schools","batches","students","student_education","student_jp_exams","sponsors","batch_students","payments","expenses","employees","tasks","attendance","communications","calendar_events","documents","submissions","inventory"];
  for (const t of tables) {
    const { count } = await s.from(t).select("*", { count:"exact", head:true });
    console.log(`  ${t}: ${count}`);
  }
}

seed().catch(console.error);
