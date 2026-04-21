/**
 * studentData.js — Student object → flat key-value map, field alias resolution
 *
 * flattenStudent: nested student data (education, sponsor, family, work) কে
 * flat {{placeholder}} key-value-তে convert করে। Encrypted fields auto-decrypt।
 *
 * resolveFieldValue: template-এ যেকোনো নাম (alias/case/modifier) দিলে
 * সঠিক value resolve করে — date/name modifiers support সহ।
 */

const { decryptSensitiveFields } = require("../crypto");

// Student object-কে flat key-value-তে convert (nested education, sponsor etc.)
// Encrypted fields auto-decrypt হয়
function flattenStudent(student) {
  const decrypted = decryptSensitiveFields(student);
  const flat = { ...decrypted };

  // ── Date fields normalize — pg driver Date object কে "YYYY-MM-DD" string-এ convert ──
  for (const key of Object.keys(flat)) {
    if (flat[key] instanceof Date) {
      flat[key] = flat[key].toISOString().slice(0, 10);
    }
  }

  // ── Field alias mapping — DB column name → Excel placeholder key ──
  // DB-তে father_name/father_en/mother_name/mother_en আছে, Excel-এ father_name_en/mother_name_en ব্যবহার হয়
  flat.father_name_en = flat.father_name_en || flat.father_en || flat.father_name || "";
  flat.mother_name_en = flat.mother_name_en || flat.mother_en || flat.mother_name || "";
  flat.father_name = flat.father_name || flat.father_name_en || "";
  flat.mother_name = flat.mother_name || flat.mother_name_en || "";
  flat.passport_number = flat.passport_number || flat.passport || "";
  flat.permanent_address = flat.permanent_address || flat.present_address || "";
  flat.current_address = flat.current_address || flat.present_address || flat.permanent_address || "";
  flat.birth_place = flat.birth_place || "";
  flat.occupation = flat.occupation || "";
  flat.marital_status = flat.marital_status || "";
  flat.nationality = flat.nationality || "Bangladeshi";
  flat.blood_group = flat.blood_group || "";
  flat.name_katakana = flat.name_katakana || "";

  // Study plan fields — DB-তে students table-এ সরাসরি আছে
  flat.reason_for_study = flat.reason_for_study || student.reason_for_study || "";
  flat.future_plan = flat.future_plan || student.future_plan || "";
  flat.study_subject = flat.study_subject || student.study_subject || "";

  // Additional personal fields
  flat.birth_place = flat.birth_place || student.birth_place || "";
  flat.occupation = flat.occupation || student.occupation || "";
  flat.spouse_name = flat.spouse_name || student.spouse_name || "";
  flat.emergency_contact = flat.emergency_contact || student.emergency_contact || "";
  flat.emergency_phone = flat.emergency_phone || student.emergency_phone || "";

  // Education: SSC, HSC, Honours
  const edu = student.student_education || student.education || [];
  const ssc = edu.find(e => (e.level || "").toLowerCase().includes("ssc")) || {};
  const hsc = edu.find(e => (e.level || "").toLowerCase().includes("hsc")) || {};
  const honours = edu.find(e => (e.level || "").toLowerCase().includes("hon") || (e.level || "").toLowerCase().includes("bach")) || {};
  flat.edu_ssc_school = ssc.school_name || ""; flat.edu_ssc_year = ssc.passing_year || ssc.year || ""; flat.edu_ssc_board = ssc.board || ""; flat.edu_ssc_gpa = ssc.gpa || ""; flat.edu_ssc_subject = ssc.subject_group || ssc.group_name || "";
  flat.edu_ssc_address = ssc.address || "";
  flat.edu_ssc_entrance = ssc.entrance_year || "";
  flat.edu_hsc_school = hsc.school_name || ""; flat.edu_hsc_year = hsc.passing_year || hsc.year || ""; flat.edu_hsc_board = hsc.board || ""; flat.edu_hsc_gpa = hsc.gpa || ""; flat.edu_hsc_subject = hsc.subject_group || hsc.group_name || "";
  flat.edu_hsc_address = hsc.address || "";
  flat.edu_hsc_entrance = hsc.entrance_year || "";
  flat.edu_honours_school = honours.school_name || ""; flat.edu_honours_year = honours.passing_year || honours.year || ""; flat.edu_honours_gpa = honours.gpa || ""; flat.edu_honours_subject = honours.subject_group || honours.group_name || "";
  flat.edu_honours_address = honours.address || "";
  flat.edu_honours_entrance = honours.entrance_year || "";

  // ── Japanese form education — বাংলাদেশ শিক্ষা ব্যবস্থা mapping ──
  // Elementary (小学校) = প্রাথমিক (১-৫ শ্রেণী)
  // Junior High (中学校) = জুনিয়র/SSC (৬-১০ শ্রেণী) — SSC ডিগ্রি
  // High School (高等学校) = উচ্চ মাধ্যমিক/HSC (১১-১২) — HSC ডিগ্রি
  // Technical (専門学校) = টেকনিক্যাল/Diploma (SSC পরবর্তী)
  // University (大学) = বিশ্ববিদ্যালয়/Honours
  const elementary = edu.find(e => /elementary|primary|psc|小学/i.test(e.level || "") || /elementary/i.test(e.school_type || "")) || {};
  const junior = edu.find(e => /^ssc$|junior.*high|jsc|中学/i.test(e.level || "") || /junior/i.test(e.school_type || "")) || {};
  const highSchool = edu.find(e => /^hsc$|^high|alim|diploma.*hsc|高等/i.test(e.level || "") || /^high/i.test(e.school_type || "")) || {};
  const technical = edu.find(e => /technical|diploma|polytechnic|専門/i.test(e.level || "") || /technical/i.test(e.school_type || "")) || {};
  const juniorCollege = edu.find(e => /junior.*college|短期/i.test(e.level || "") || /junior.*college/i.test(e.school_type || "")) || {};
  const university = edu.find(e => /university|honours|hon|bach|degree|大学/i.test(e.level || "") || /university/i.test(e.school_type || "")) || {};

  // Each level: school, address, entrance_year/month, graduation_year/month, years (在学年数)
  const eduMap = { elementary, junior, highSchool: highSchool, technical, juniorCollege, university };
  for (const [prefix, e] of Object.entries(eduMap)) {
    const p = `edu_${prefix}`;
    flat[`${p}_school`] = e.school_name || "";
    flat[`${p}_address`] = e.address || "";
    flat[`${p}_entrance`] = e.entrance_year || "";
    flat[`${p}_entrance_month`] = e.entrance_month || "";
    // graduation/passing year — DB-তে "year" column-এ "2015-12" format থাকে
    flat[`${p}_graduation`] = e.passing_year || e.graduation_year || e.year || "";
    flat[`${p}_graduation_month`] = e.graduation_month || e.passing_month || "";
    // 在学年数 (years of study) — entrance から graduation まで
    const gradYear = e.passing_year || e.graduation_year || e.year || "";
    if (e.entrance_year && gradYear) {
      flat[`${p}_years`] = String(parseInt(gradYear) - parseInt(e.entrance_year));
    } else {
      flat[`${p}_years`] = "";
    }
  }

  // JP Exams
  const jp = (student.student_jp_exams || [])[0] || {};
  flat.jp_exam_type = jp.exam_type || ""; flat.jp_level = jp.level || ""; flat.jp_score = jp.score || ""; flat.jp_result = jp.result || ""; flat.jp_exam_date = jp.exam_date || "";

  // Sponsor
  const spRaw = (student.sponsors || [])[0] || student.sponsor || {};
  const sp = decryptSensitiveFields(spRaw);
  flat.sponsor_name = sp.name || ""; flat.sponsor_name_en = sp.name_en || sp.name || "";
  flat.sponsor_relationship = sp.relationship || ""; flat.sponsor_phone = sp.phone || "";
  flat.sponsor_address = sp.permanent_address || sp.present_address || sp.address || "";
  flat.sponsor_present_address = sp.present_address || sp.address || "";
  flat.sponsor_permanent_address = sp.permanent_address || sp.address || "";
  flat.sponsor_company = sp.company_name || "";
  flat.sponsor_company_name = sp.company_name || "";
  flat.sponsor_company_phone = sp.company_phone || "";
  flat.sponsor_company_address = sp.company_address || "";
  flat.sponsor_trade_license = sp.trade_license || sp.trade_license_no || "";
  flat.sponsor_work_address = sp.work_address || "";
  // Sponsor parents
  flat.sponsor_father_name = sp.father_name || "";
  flat.sponsor_mother_name = sp.mother_name || "";
  // Tax/Income
  flat.sponsor_dob = sp.dob || "";
  flat.sponsor_nid = sp.nid || "";
  flat.sponsor_tin = sp.tin || "";
  flat.sponsor_income_year_1 = sp.income_year_1 || "";
  flat.sponsor_income_year_2 = sp.income_year_2 || "";
  flat.sponsor_income_year_3 = sp.income_year_3 || "";
  flat.sponsor_income_source_1 = sp.income_source_1 || "";
  flat.sponsor_income_source_2 = sp.income_source_2 || "";
  flat.sponsor_income_source_3 = sp.income_source_3 || "";
  flat.sponsor_income_y1 = sp.annual_income_y1 || ""; flat.sponsor_income_y2 = sp.annual_income_y2 || ""; flat.sponsor_income_y3 = sp.annual_income_y3 || "";
  flat.sponsor_income = sp.annual_income_y1 || "";
  flat.sponsor_tax_y1 = sp.tax_y1 || ""; flat.sponsor_tax_y2 = sp.tax_y2 || ""; flat.sponsor_tax_y3 = sp.tax_y3 || "";
  flat.sponsor_statement = sp.statement || "";

  // Family
  const fam = student.student_family || [];
  const father = fam.find(f => f.relation === "father") || {};
  const mother = fam.find(f => f.relation === "mother") || {};
  // Father/Mother — student_family table fallback → students table direct fields
  flat.father_dob = father.dob || flat.father_dob || student.father_dob || "";
  flat.father_occupation = father.occupation || flat.father_occupation || student.father_occupation || "";
  flat.father_phone = father.phone || flat.father_phone || "";
  flat.mother_dob = mother.dob || flat.mother_dob || student.mother_dob || "";
  flat.mother_occupation = mother.occupation || flat.mother_occupation || student.mother_occupation || "";
  flat.mother_phone = mother.phone || flat.mother_phone || "";

  // Family detailed (family1, family2, family3)
  fam.forEach((f, i) => {
    const idx = i + 1;
    flat[`family${idx}_name`] = f.name || "";
    flat[`family${idx}_relation`] = f.relation || "";
    flat[`family${idx}_dob`] = f.dob || "";
    flat[`family${idx}_occupation`] = f.occupation || "";
    flat[`family${idx}_address`] = f.address || "";
  });

  // Age from DOB
  if (flat.dob) {
    const age = Math.floor((Date.now() - new Date(flat.dob)) / (365.25 * 24 * 60 * 60 * 1000));
    flat.age = String(age);
  }

  // ── JP Study History — agency+batch fallback (docgen.js-এর মতো) ──
  const jpStudyAll = student.jp_study || [];
  const jpStudy = jpStudyAll[0] || {};
  flat.jp_study_institution = jpStudy.institution || flat.sys_agency_name || "";
  flat.jp_study_address = jpStudy.address || flat.sys_agency_address || "";
  flat.jp_study_from = jpStudy.period_from || flat.sys_batch_start || "";
  flat.jp_study_to = jpStudy.period_to || flat.sys_batch_end || "";
  flat.jp_study_hours = jpStudy.total_hours || flat.sys_batch_hours || "";

  // ── Work Experience — 職歴 ──
  const workAll = student.work_experience || [];
  workAll.forEach((w, i) => {
    const idx = i + 1;
    flat[`work${idx}_company`] = w.company_name || "";
    flat[`work${idx}_address`] = w.address || "";
    flat[`work${idx}_position`] = w.position || "";
    flat[`work${idx}_start`] = w.start_date || "";
    flat[`work${idx}_end`] = w.end_date || "";
  });
  // Shorthand — first entry
  const work = workAll[0] || {};
  flat.work_company = work.company_name || "";
  flat.work_address = work.address || "";
  flat.work_position = work.position || "";
  flat.work_start = work.start_date || "";
  flat.work_end = work.end_date || "";

  return flat;
}

// ── Key alias map — template-এ যেকোনো নাম লিখলে সঠিক flat key-তে resolve হবে ──
const KEY_ALIASES = {
  placeofbirth: "birth_place", place_of_birth: "birth_place",
  st_phone: "phone", telephone: "phone", tel: "phone",
  full_name: "name_en", fullname: "name_en", alphabet: "name_en",
  katakana: "name_katakana",
  sex: "gender",
  birthday: "dob", dateofbirth: "dob", date_of_birth: "dob",
  passport: "passport_number", passport_no: "passport_number",
  address: "permanent_address", registered_address: "permanent_address",
  present_address: "current_address",
  spouse: "spouse_name", spouse_name: "spouse_name",
  father: "father_name_en", father_name: "father_name_en",
  mother: "mother_name_en", mother_name: "mother_name_en",
  father_occupation: "father_occupation", father_dob: "father_dob",
  mother_occupation: "mother_occupation", mother_dob: "mother_dob",
  // Education aliases — AI বিভিন্ন নামে দিতে পারে
  edu_elelementary_name: "edu_elementary_school", edu_elementary_name: "edu_elementary_school",
  edu_elelementary_add: "edu_elementary_address", edu_elementary_add: "edu_elementary_address",
  edu_junior_name: "edu_junior_school", edu_junior_add: "edu_junior_address",
  edu_hsc_add: "edu_hsc_address", edu_hsc_name: "edu_hsc_school",
  edu_technical_name: "edu_technical_school", edu_technical_add: "edu_technical_address",
  edu_university_name: "edu_university_school", edu_university_add: "edu_university_address",
  edu_juniorcollege_name: "edu_juniorCollege_school", edu_juniorcollege_add: "edu_juniorCollege_address",
  // Education — honours aliases
  edu_honours_add: "edu_honours_address",
  // Passport date aliases — template-এ "Passport Issue", "Passport Expiry" ব্যবহার হতে পারে
  "passport issue": "passport_issue", "passport_issue_date": "passport_issue",
  "passport expiry": "passport_expiry", "passport_expiry_date": "passport_expiry",
  // Sponsor
  sponsor: "sponsor_name_en",
  // JP
  jlpt: "jp_level", jlpt_level: "jp_level", jlpt_score: "jp_score",
  // Study
  reason_for_study: "reason_for_study", purpose_of_study: "reason_for_study",
  study_plan: "reason_for_study", future_plan: "future_plan",
  // Work experience aliases
  work_company_name: "work_company", company_name: "work_company",
  work_start_date: "work_start", work_end_date: "work_end",
  // System
  agency_name: "sys_agency_name", agency_address: "sys_agency_address",
  school_name: "sys_school_name", school_name_jp: "sys_school_name_jp",
};

/**
 * resolveFieldValue — sub-field support
 * key format: "field_name" বা "field_name:modifier"
 *
 * Date modifiers: :year, :month, :day
 *   dob:year → "1998", dob:month → "03", dob:day → "12"
 *
 * Name modifiers: :first, :last
 *   name_en:first → "Mohammad", name_en:last → "Rahim"
 *   "Mohammad Rahim" → first="Mohammad", last="Rahim"
 */
function resolveFieldValue(flat, fieldKey) {
  if (!fieldKey) return "";

  // ── Normalize — double colon ও duplicate modifier fix ──
  // "dob::day:day:day" → "dob:day", "dob:month:month:month" → "dob:month"
  fieldKey = fieldKey.replace(/:+/g, ":").replace(/:$/, "");
  if (fieldKey.includes(":")) {
    const parts = fieldKey.split(":");
    // unique modifier — শেষ valid modifier নাও
    const base = parts[0];
    const mod = parts.find((p, i) => i > 0 && p) || "";
    fieldKey = mod ? `${base}:${mod}` : base;
  }

  // Sub-field check: "dob:year", "name_en:first", etc.
  if (fieldKey.includes(":")) {
    const [baseKey, modifier] = fieldKey.split(":");
    // Base key alias resolve
    const resolvedBase = KEY_ALIASES[baseKey.toLowerCase()] || baseKey;
    let rawValue = flat[resolvedBase] ?? flat[baseKey] ?? "";
    // Case-insensitive fallback
    if (!rawValue) {
      const lk = resolvedBase.toLowerCase();
      for (const [k, v] of Object.entries(flat)) { if (k.toLowerCase() === lk && v) { rawValue = v; break; } }
    }
    if (!rawValue) return "";

    // Date object → ISO string convert
    if (rawValue instanceof Date) rawValue = rawValue.toISOString().slice(0, 10);

    // Date modifiers
    if (["year", "month", "day"].includes(modifier)) {
      // Date format: "1998-03-12" বা "03/12/1998" বা "1998/03/12"
      const dateStr = String(rawValue);
      let y = "", m = "", d = "";

      if (dateStr.includes("-")) {
        // ISO format: 1998-03-12
        const parts = dateStr.split("-");
        y = parts[0] || ""; m = parts[1] || ""; d = parts[2]?.slice(0, 2) || "";
      } else if (dateStr.includes("/")) {
        const parts = dateStr.split("/");
        if (parts[0].length === 4) { y = parts[0]; m = parts[1]; d = parts[2]; } // 1998/03/12
        else { m = parts[0]; d = parts[1]; y = parts[2]; } // 03/12/1998
      }

      if (modifier === "year") return y;
      if (modifier === "month") return m;
      if (modifier === "day") return d;
    }

    // Name modifiers
    if (["first", "last"].includes(modifier)) {
      const nameParts = String(rawValue).trim().split(/\s+/);
      if (modifier === "first") return nameParts[0] || "";
      if (modifier === "last") return nameParts.slice(1).join(" ") || nameParts[0] || "";
    }

    return rawValue; // unknown modifier → full value
  }

  // No modifier → direct value, with alias + case-insensitive fallback
  // Date object হলে ISO string-এ convert
  if (flat[fieldKey] instanceof Date) return flat[fieldKey].toISOString().slice(0, 10);
  if (flat[fieldKey] !== undefined && flat[fieldKey] !== "") return flat[fieldKey];

  // Alias lookup
  const alias = KEY_ALIASES[fieldKey.toLowerCase()];
  if (alias && flat[alias] !== undefined && flat[alias] !== "") return flat[alias];

  // Case-insensitive search — flat keys-এ exact match না পেলে
  const lowerKey = fieldKey.toLowerCase();
  for (const [k, v] of Object.entries(flat)) {
    if (k.toLowerCase() === lowerKey && v !== undefined && v !== "") return v;
  }

  return flat[fieldKey] ?? "";
}

module.exports = {
  flattenStudent,
  resolveFieldValue,
  KEY_ALIASES,
};
