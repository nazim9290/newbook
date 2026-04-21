/**
 * cellUtils.js — Excel cell/text/label পরীক্ষণের pure helper functions
 *
 * এই file-এ কোনো external dependency নেই — সব খাঁটি string/cell manipulation।
 * routes/excel/* ও lib/excel/* থেকে import হবে।
 */

// Filename sanitization — path traversal ও special char সরাও
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Column number → letter (1=A, 26=Z, 27=AA)
function colLetter(col) {
  let s = "";
  while (col > 0) { col--; s = String.fromCharCode(65 + (col % 26)) + s; col = Math.floor(col / 26); }
  return s;
}

// Column letter → number (A=1, B=2, ..., AA=27)
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ExcelJS cell থেকে plain text extract — richText / formula / object support
function getCellText(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return "";
  try {
    // richText format (styled text)
    if (cell.value && cell.value.richText) {
      return cell.value.richText.map(r => r.text || "").join("").trim();
    }
    // formula result
    if (cell.value && typeof cell.value === "object" && cell.value.result !== undefined) {
      return cell.value.result != null ? String(cell.value.result).trim() : "";
    }
    // text property (most common)
    if (cell.text) return String(cell.text).trim();
    // direct value
    return cell.value != null ? String(cell.value).trim() : "";
  } catch {
    return "";
  }
}

// File-safe name encode — English/Bengali/Japanese allow
function encName(s) {
  return (s || "export").replace(/[^a-zA-Z0-9_\-\u0980-\u09FF\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF ]/g, "").substring(0, 50);
}

// Encrypted hash detect — "iv:authTag:ciphertext" format (hex:hex:hex)
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  return /^[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/i.test(val);
}

// Form label কিনা check — user data নয়, ফর্ম ফিল্ডের নাম
function isLabel(text) {
  if (!text || text.length > 50) return false;
  // Japanese labels: contains kanji/katakana form words
  if (/[氏名前生年月日性別国籍住所学歴旅券番号電話職業婚姻区分出生地戸籍携帯学校入学卒業資格]/.test(text)) return true;
  // English labels
  if (/^(name|sex|date|birth|address|phone|tel|email|passport|school|nationality|occupation|marital|full name|status)/i.test(text)) return true;
  // Form keywords
  if (/^(elementary|junior|high|college|university|technical)/i.test(text)) return true;
  if (/^(year|month|day|no\.|number)/i.test(text)) return true;
  // Bengali labels
  if (/[নামঠিকানাফোনজন্মপিতামাতাপেশা]/.test(text)) return true;
  // Short text with specific patterns
  if (/^[A-Z][a-z]+\s+(of|for|from|in)\s/i.test(text)) return true;
  // Column headers
  if (/^(date of|name of|place of)/i.test(text)) return true;
  return false;
}

// Label text থেকে system field key auto-detect
function autoDetect(label) {
  if (!label) return "";
  const l = label.toLowerCase();
  // More comprehensive rules for real Japanese school forms
  const rules = [
    // Personal - exact patterns from real forms
    [["full name", "氏名", "alphabet", "ふりがな"], "name_en"],
    [["カタカナ", "katakana", "フリガナ"], "name_katakana"],
    [["生年月日", "date of birth", "birthday", "誕生日"], "dob"],
    [["性別", "sex", "gender", "男女"], "gender"],
    [["国籍", "nationality"], "nationality"],
    [["出生地", "place of birth", "birthplace"], "permanent_address"],
    [["婚姻", "marital", "single", "married"], "marital_status"],
    [["name of spouse", "配偶者"], "spouse_name"],
    [["職業", "occupation"], "father_occupation"],

    // Contact
    [["電話番号", "telephone", "phone", "tel", "携帯"], "phone"],
    [["メール", "email", "e-mail"], "email"],

    // Address
    [["戸籍住所", "registered address", "本籍"], "permanent_address"],
    [["現住所", "present address", "現在の住所"], "current_address"],

    // Passport
    [["旅券番号", "passport no", "passport number"], "passport_number"],
    [["発行日", "date of issue", "発行年月日"], "passport_issue"],
    [["有効期限", "date of expir", "有効期間"], "passport_expiry"],

    // Family
    [["父の名前", "father", "父親"], "father_name_en"],
    [["母の名前", "mother", "母親"], "mother_name_en"],

    // Education
    [["elementary", "小学校", "初等"], "edu_ssc_school"],
    [["junior high", "中学校", "中等"], "edu_ssc_school"],
    [["high school", "高等学校", "高校"], "edu_hsc_school"],
    [["college", "大学", "短期大学"], "edu_honours_school"],
    [["university", "大学院"], "edu_honours_school"],
    [["technical", "専門学校"], "edu_honours_school"],
    [["学校名", "name of school", "学校"], "edu_ssc_school"],
    [["入学年", "date of entrance", "入学"], "edu_ssc_year"],
    [["卒業年", "date of graduat", "卒業"], "edu_ssc_year"],

    // Japanese
    [["日本語能力", "jlpt", "japanese language"], "jp_level"],
    [["日本語学習歴", "japanese study"], "jp_exam_type"],

    // Sponsor
    [["経費支弁者", "sponsor", "保証人", "支弁者"], "sponsor_name"],
    [["年収", "annual income", "収入"], "sponsor_income_y1"],
    [["勤務先", "employer", "会社"], "sponsor_company"],

    // Visa
    [["在留資格", "status of residence", "visa status"], "visa_type"],
    [["入国目的", "purpose of entry"], "visa_type"],
    [["入国日", "date of entry"], ""],
    [["出国日", "date of departure"], ""],
  ];

  for (const [keywords, field] of rules) {
    if (keywords.some((k) => l.includes(k))) return field;
  }
  return "";
}

module.exports = {
  sanitize,
  colLetter,
  colToNum,
  getCellText,
  encName,
  looksEncrypted,
  isLabel,
  autoDetect,
};
