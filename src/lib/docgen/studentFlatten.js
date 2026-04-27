/**
 * studentFlatten.js — DocGen student data flatten
 *
 * Nested student data (education, sponsor, family, work, jp_study) কে flat key-value
 * map-এ convert — {{placeholder}} replacement-এ ব্যবহার।
 *
 * context: { agency, school, batch, branch } — sys_* ভ্যারিয়েবলের জন্য
 */

const { decryptSensitiveFields } = require("../crypto");

function flattenForDoc(student, context = {}) {
  const flat = { ...student };

  // ── Date object → "YYYY-MM-DD" string normalize (pg driver Date object return করে) ──
  for (const key of Object.keys(flat)) {
    if (flat[key] instanceof Date) flat[key] = flat[key].toISOString().slice(0, 10);
  }

  // ═══════════════════════════════════════════════════
  // Education — SSC, HSC, Honours/Bachelor
  // ═══════════════════════════════════════════════════
  const edu = student.student_education || student.education || [];
  const ssc = edu.find(e => (e.level || "").toLowerCase().includes("ssc")) || {};
  const hsc = edu.find(e => (e.level || "").toLowerCase().includes("hsc")) || {};
  const honours = edu.find(e => (e.level || "").toLowerCase().includes("bachelor") || (e.level || "").toLowerCase().includes("hon")) || {};

  flat.edu_ssc_school = ssc.school_name || "";
  flat.edu_ssc_year = ssc.passing_year || ssc.year || "";
  flat.edu_ssc_board = ssc.board || "";
  flat.edu_ssc_gpa = ssc.gpa || "";
  flat.edu_ssc_subject = ssc.group_name || ssc.subject_group || ssc.department || "";

  flat.edu_hsc_school = hsc.school_name || "";
  flat.edu_hsc_year = hsc.passing_year || hsc.year || "";
  flat.edu_hsc_board = hsc.board || "";
  flat.edu_hsc_gpa = hsc.gpa || "";
  flat.edu_hsc_subject = hsc.group_name || hsc.subject_group || hsc.department || "";

  flat.edu_honours_school = honours.school_name || "";
  flat.edu_honours_year = honours.passing_year || honours.year || "";
  flat.edu_honours_gpa = honours.gpa || "";
  flat.edu_honours_subject = honours.group_name || honours.subject_group || honours.department || "";

  // ═══════════════════════════════════════════════════
  // JP Exams
  // ═══════════════════════════════════════════════════
  const jp = (student.student_jp_exams || [])[0] || {};
  flat.jp_level = jp.level || ""; flat.jp_score = jp.score || "";
  flat.jp_exam_type = jp.exam_type || ""; flat.jp_result = jp.result || "";
  flat.jp_exam_date = jp.exam_date || "";

  // ═══════════════════════════════════════════════════
  // Sponsor — মূল তথ্য + 経費支弁書 extended fields
  // ═══════════════════════════════════════════════════
  const spRaw = (student.sponsors || [])[0] || {};
  const sp = decryptSensitiveFields(spRaw);
  flat.sponsor_name = sp.name || ""; flat.sponsor_name_en = sp.name_en || sp.name || "";
  flat.sponsor_phone = sp.phone || "";
  flat.sponsor_address = sp.address || sp.permanent_address || "";
  flat.sponsor_relationship = sp.relationship || "";
  flat.sponsor_dob = sp.dob || "";
  flat.sponsor_nid = sp.nid || "";
  // ── Sponsor addresses ──
  flat.sponsor_present_address = sp.present_address || sp.address || "";
  flat.sponsor_permanent_address = sp.permanent_address || sp.address || "";
  // ── Sponsor parents ──
  flat.sponsor_father_name = sp.father_name || "";
  flat.sponsor_mother_name = sp.mother_name || "";
  // ── Business ──
  flat.sponsor_company = sp.company_name || "";
  flat.sponsor_company_name = sp.company_name || "";
  flat.sponsor_company_phone = sp.company_phone || "";
  flat.sponsor_company_address = sp.company_address || "";
  flat.sponsor_trade_license = sp.trade_license || sp.trade_license_no || "";
  flat.sponsor_work_address = sp.work_address || "";
  // ── Tax/Income — Assessment Year + Source + Amount ──
  flat.sponsor_tin = sp.tin || "";
  flat.sponsor_income_year_1 = sp.income_year_1 || "";
  flat.sponsor_income_year_2 = sp.income_year_2 || "";
  flat.sponsor_income_year_3 = sp.income_year_3 || "";
  flat.sponsor_income_source_1 = sp.income_source_1 || "Business Income";
  flat.sponsor_income_source_2 = sp.income_source_2 || "Business Income";
  flat.sponsor_income_source_3 = sp.income_source_3 || "Business Income";
  flat.sponsor_income_y1 = sp.annual_income_y1 || "";
  flat.sponsor_income_y2 = sp.annual_income_y2 || "";
  flat.sponsor_income_y3 = sp.annual_income_y3 || "";
  flat.sponsor_income = sp.annual_income_y1 || "";
  flat.sponsor_tax_y1 = sp.tax_paid_y1 || sp.tax_y1 || "";
  flat.sponsor_tax_y2 = sp.tax_paid_y2 || sp.tax_y2 || "";
  flat.sponsor_tax_y3 = sp.tax_paid_y3 || sp.tax_y3 || "";
  // ── Statement ──
  flat.sponsor_statement = sp.statement || "";
  flat.sponsor_sign_date = sp.sign_date || "";
  flat.sponsor_payment_to_student = sp.payment_to_student ? "✓" : "";
  flat.sponsor_payment_to_school = sp.payment_to_school ? "✓" : "";
  // ── Japan finance ──
  flat.tuition_jpy = sp.tuition_jpy || student.tuition_jpy || "";
  flat.monthly_living = sp.living_jpy_monthly || student.monthly_living || "";
  flat.exchange_rate = sp.exchange_rate || "";

  // ═══════════════════════════════════════════════════
  // New Student fields — 入学願書 (Application for Admission)
  // birth_place, occupation, reason_for_study, future_plan, study_subject
  // ═══════════════════════════════════════════════════
  flat.birth_place = student.birth_place || "";
  flat.occupation = student.occupation || "Student";
  flat.reason_for_study = student.reason_for_study || "";
  flat.future_plan = student.future_plan || "";
  flat.study_subject = student.study_subject || "";

  // ═══════════════════════════════════════════════════
  // Detailed Education — elementary, junior_high, high_school (入学/卒業 + 所在地)
  // school_type / level で各段階を特定してflat key化
  // ═══════════════════════════════════════════════════
  const eduAll = student.student_education || student.education || [];
  const elementary = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("elem")) || {};
  const juniorHigh = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("junior")) || {};
  const highSchool = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("high") || (e.level || "").toLowerCase().includes("ssc")) || {};
  const technical = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("tech")) || {};
  const university = eduAll.find(e => (e.school_type || e.level || "").toLowerCase().includes("univ") || (e.level || "").toLowerCase().includes("bach")) || {};

  // Education helper — YYYY-MM format থেকে year, month আলাদা + duration calculate
  const eduFlat = (prefix, rec) => {
    const entrance = rec.entrance_year || "";
    const graduation = rec.passing_year || rec.year || "";
    flat[`${prefix}_school`] = rec.school_name || "";
    flat[`${prefix}_address`] = rec.address || "";
    flat[`${prefix}_entrance`] = entrance;
    flat[`${prefix}_graduation`] = graduation;
    // Sub-parts: "2009-01" → year=2009, month=1
    if (entrance.includes("-")) {
      const [ey, em] = entrance.split("-");
      flat[`${prefix}_entrance_year`] = ey || "";
      flat[`${prefix}_entrance_month`] = String(parseInt(em || "0")) || "";
    }
    if (graduation.includes("-")) {
      const [gy, gm] = graduation.split("-");
      flat[`${prefix}_graduation_year`] = gy || "";
      flat[`${prefix}_graduation_month`] = String(parseInt(gm || "0")) || "";
    }
    // Duration (年) — graduation year - entrance year
    const ey = parseInt((entrance || "").split("-")[0]);
    const gy = parseInt((graduation || "").split("-")[0]);
    flat[`${prefix}_duration`] = (ey && gy) ? String(gy - ey) : "";
  };

  eduFlat("edu_elementary", elementary);
  eduFlat("edu_junior", juniorHigh);
  eduFlat("edu_high", highSchool);
  eduFlat("edu_technical", technical);
  eduFlat("edu_university", university);

  // ═══════════════════════════════════════════════════
  // Work Experience — 職歴 (Vocational experience)
  // ═══════════════════════════════════════════════════
  const workAll = student.work_experience || [];
  workAll.forEach((w, i) => {
    flat[`work${i+1}_company`] = w.company_name || "";
    flat[`work${i+1}_address`] = w.address || "";
    flat[`work${i+1}_start`] = w.start_date || "";
    flat[`work${i+1}_end`] = w.end_date || "";
    flat[`work${i+1}_position`] = w.position || "";
  });
  // Shorthand — first entry without index (backward compat)
  const work = workAll[0] || {};
  flat.work_company = work.company_name || "";
  flat.work_address = work.address || "";
  flat.work_start = work.start_date || "";
  flat.work_end = work.end_date || "";
  flat.work_position = work.position || "";

  // ═══════════════════════════════════════════════════
  // JP Study History — 日本語学習歴 (Japanese educational history)
  // ═══════════════════════════════════════════════════
  const jpStudyAll = student.jp_study || [];
  jpStudyAll.forEach((js, i) => {
    flat[`jp_study${i+1}_institution`] = js.institution || "";
    flat[`jp_study${i+1}_address`] = js.address || "";
    flat[`jp_study${i+1}_from`] = js.period_from || "";
    flat[`jp_study${i+1}_to`] = js.period_to || "";
    flat[`jp_study${i+1}_hours`] = js.total_hours || "";
  });
  // Shorthand — first entry without index
  // JP Study data না থাকলে agency + batch data দিয়ে auto-populate
  const jpStudy = jpStudyAll[0] || {};
  const ctxAgency = (context || {}).agency || {};
  const ctxBatch = (context || {}).batch || {};
  flat.jp_study_institution = jpStudy.institution || ctxAgency.name || "";
  flat.jp_study_address = jpStudy.address || ctxAgency.address || "";
  flat.jp_study_from = jpStudy.period_from || ctxBatch.start_date || "";
  flat.jp_study_to = jpStudy.period_to || ctxBatch.end_date || "";
  flat.jp_study_hours = jpStudy.total_hours || ctxBatch.total_hours || "";
  // Date object → string normalize
  if (flat.jp_study_from instanceof Date) flat.jp_study_from = flat.jp_study_from.toISOString().slice(0, 10);
  if (flat.jp_study_to instanceof Date) flat.jp_study_to = flat.jp_study_to.toISOString().slice(0, 10);
  // JP Study sub-parts — "2023-03-02" → year=2023, month=3, day=2
  if (flat.jp_study_from && String(flat.jp_study_from).includes("-")) {
    const [fy, fm, fd] = flat.jp_study_from.split("-");
    flat.jp_study_from_year = fy || ""; flat.jp_study_from_month = String(parseInt(fm || "0")) || ""; flat.jp_study_from_day = String(parseInt(fd || "0")) || "";
  }
  if (flat.jp_study_to && String(flat.jp_study_to).includes("-")) {
    const [ty, tm, td] = flat.jp_study_to.split("-");
    flat.jp_study_to_year = ty || ""; flat.jp_study_to_month = String(parseInt(tm || "0")) || ""; flat.jp_study_to_day = String(parseInt(td || "0")) || "";
  }

  // ═══════════════════════════════════════════════════
  // Family — বাবা, মা
  // ═══════════════════════════════════════════════════
  const fam = student.student_family || [];
  const father = fam.find(f => f.relation === "father") || {};
  const mother = fam.find(f => f.relation === "mother") || {};
  flat.father_dob = father.dob || ""; flat.father_occupation = father.occupation || "";
  flat.mother_dob = mother.dob || ""; flat.mother_occupation = mother.occupation || "";
  // Family addresses — প্রতিটি সদস্যের আলাদা ঠিকানা (入学願書 format)
  fam.forEach((m, i) => {
    flat[`family${i+1}_name`] = m.name || m.name_en || "";
    flat[`family${i+1}_relation`] = m.relation || "";
    flat[`family${i+1}_dob`] = m.dob || "";
    flat[`family${i+1}_occupation`] = m.occupation || "";
    flat[`family${i+1}_address`] = m.address || "";
  });

  // ═══════════════════════════════════════════════════
  // Extended Sponsor — 入学願書 additional fields
  // ═══════════════════════════════════════════════════
  flat.sponsor_dob = sp.dob || "";
  flat.sponsor_company_phone = sp.company_phone || "";
  flat.sponsor_company_address = sp.company_address || "";

  // ═══════════════════════════════════════════════════
  // Age — DOB থেকে বয়স
  // ═══════════════════════════════════════════════════
  if (flat.dob) {
    flat.age = String(Math.floor((Date.now() - new Date(flat.dob)) / (365.25 * 24 * 60 * 60 * 1000)));
  }

  // ═══════════════════════════════════════════════════
  // Today's date — বিভিন্ন format
  // ═══════════════════════════════════════════════════
  const today = new Date();
  flat.today = today.toISOString().slice(0, 10);
  flat.today_jp = today.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

  // ═══════════════════════════════════════════════════
  // System Variables — agency, branch, school, batch
  // context থেকে DB data ব্যবহার করে sys_* prefix-এ set
  // ═══════════════════════════════════════════════════
  const { agency = {}, school = {}, batch = {}, branch = {} } = context;

  // এজেন্সি
  flat.sys_agency_name = agency.name || "";
  flat.sys_agency_name_bn = agency.name_bn || "";
  flat.sys_agency_address = agency.address || "";
  flat.sys_agency_phone = agency.phone || "";
  flat.sys_agency_email = agency.email || "";

  // ব্রাঞ্চ — fallback: student.branch (name string)
  flat.sys_branch_name = branch.name || student.branch || "";
  flat.sys_branch_address = branch.address || branch.address_bn || "";
  flat.sys_branch_phone = branch.phone || "";
  flat.sys_branch_manager = branch.manager || "";

  // স্কুল — fallback: student.school (name string)
  flat.sys_school_name = school.name_en || student.school || "";
  flat.sys_school_name_jp = school.name_jp || "";
  flat.sys_school_address = school.address || "";

  // ব্যাচ — fallback: student.batch (name string)
  flat.sys_batch_name = batch.name || student.batch || "";
  flat.sys_batch_start = batch.start_date || "";
  flat.sys_batch_end = batch.end_date || "";
  flat.sys_batch_teacher = batch.teacher || "";
  flat.sys_batch_schedule = batch.schedule || "";

  // ব্যাচ শিডিউল — ক্লাসের দিন, সময়, ঘণ্টা (auto-calculated)
  flat.sys_batch_class_days = (batch.class_days || []).join(", ");
  flat.sys_batch_class_time = batch.class_time || "";
  flat.sys_batch_hours_per_day = batch.class_hours_per_day || "";
  flat.sys_batch_weekly_hours = batch.weekly_hours || "";
  flat.sys_batch_total_classes = batch.total_classes || "";
  flat.sys_batch_total_hours = batch.total_hours || "";

  // sys_today — today alias with sys_ prefix
  flat.sys_today = flat.today;
  flat.sys_today_jp = flat.today_jp;

  return flat;
}

/**
 * docTypeSlug — Doc Type name → URL/key safe slug
 * "TIN Certificate" → "doc_tin_certificate"
 * Frontend ও backend দুই জায়গায় এই helper-এর exact same logic দরকার।
 */
function docTypeSlug(name) {
  return "doc_" + String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * mergeDocData — document_data rows-এর field_data কে namespaced key-তে flat-এ merge করে
 *
 * @param {Object} flat — flattenForDoc()-এর output
 * @param {Array}  docDataRows — [{ field_data, doc_type:{name} OR doc_types:{name} }]
 *
 * Namespace example:  TIN Certificate-এর field "father_name" → flat["doc_tin_certificate.father_name"]
 * Doc-type field-এ student-profile field-এর সাথে collision (যেমন "name_en") থাকলেও
 * student-profile data সরে না — দুই key পাশাপাশি থাকে।
 */
function mergeDocData(flat, docDataRows = []) {
  if (!Array.isArray(docDataRows)) return flat;
  for (const row of docDataRows) {
    const dt = row.doc_type || row.doc_types || {};
    const docName = (Array.isArray(dt) ? dt[0]?.name : dt?.name) || row.doc_type_name || "";
    if (!docName) continue;
    const slug = docTypeSlug(docName);
    const fields = row.field_data || row.fields || {};
    if (!fields || typeof fields !== "object") continue;
    for (const [k, v] of Object.entries(fields)) {
      if (k == null || k === "") continue;
      flat[`${slug}.${k}`] = v;
    }
  }
  return flat;
}

module.exports = { flattenForDoc, docTypeSlug, mergeDocData };
