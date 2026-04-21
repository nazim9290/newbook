/**
 * studentToFlat.js — Student data কে flat object-এ convert (interview list template-এ ব্যবহার)
 *
 * Output: name, family_name, given_name, dob, dob_age, age, education, gpa, jp_level...
 *         agency_name, staff_name, today (system variables)
 */

function studentToFlat(s, i, agencyName, staffName) {
  const dob = s.dob ? new Date(s.dob) : null;
  const age = dob ? Math.floor((Date.now() - dob) / 31557600000) : "";
  // জাপানি format: YYYY/MM/DD
  const dobStr = dob ? `${dob.getFullYear()}/${String(dob.getMonth() + 1).padStart(2, "0")}/${String(dob.getDate()).padStart(2, "0")}` : "";
  const dobAge = dobStr + (age ? ` (${age})` : "");
  // Family name / Given name split
  const parts = (s.name_en || "").trim().split(/\s+/);
  const familyName = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
  const givenName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  return {
    no: i + 1, serial: i + 1,
    name: s.name_en || "", full_name: s.name_en || "",
    family_name: familyName, given_name: givenName,
    name_bn: s.name_bn || "", name_jp: s.name_jp || "",
    gender: s.gender || "", gender_jp: s.gender === "Male" ? "男性" : s.gender === "Female" ? "女性" : "",
    dob: dobStr, dob_age: dobAge, age: String(age),
    nationality: s.nationality || "Bangladeshi",
    education: s.last_education || "", gpa: s.gpa || "",
    jp_level: s.jp_level || "", jp_score: s.jp_score || "", jp_exam_type: s.jp_exam_type || "",
    jp_study_hours: s.jp_study_hours || "", has_jp_cert: s.has_jp_cert ? "Yes" : "No",
    occupation: s.occupation || "Student",
    passport_no: s.passport_number || "", phone: s.phone || "", email: s.email || "",
    address: s.permanent_address || s.current_address || "",
    intake: s.intake || "", intended_semester: s.intake || "",
    sponsor: s.sponsor_name || "", sponsor_relation: s.sponsor_relation || "",
    sponsor_income: s.sponsor_income || "", sponsor_contact: s.sponsor_phone || "",
    coe_applied: s.coe_number ? "Yes" : "No",
    goal: s.goal_after_graduation || "Return to home country",
    goal_jp: s.goal_after_graduation || "帰国",
    past_visa: s.past_visa || "",
    // System variables
    agency_name: agencyName || "", staff_name: staffName || "",
    today: new Date().toISOString().slice(0, 10),
  };
}

module.exports = { studentToFlat };
