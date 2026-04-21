/**
 * valueResolver.js — DocGen placeholder value resolver
 *
 * Supported formats:
 *   {{name_en}}              → simple field
 *   {{dob:year}}             → date part: year/month/day
 *   {{name_en:first}}        → first word
 *   {{name_en:last}}         → remaining words
 *   {{dob:jp}}               → 2000年11月13日
 *   {{dob:slash}}            → 2000/11/13
 *   {{dob:dot}}              → 13.11.2000
 *   {{gender:jp}}            → Male→男, Female→女
 *   {{nationality:jp}}       → Bangladeshi→バングラデシュ
 *   {{marital_status:jp}}    → Single→未婚, Married→既婚
 *   {{field:map(A=X,B=Y)}}   → custom mapping: if field=A → X, if B → Y
 */

function resolveValue(flat, key) {
  if (!key) return "";

  // Custom mapping: {{field:map(Male=男,Female=女)}}
  const mapMatch = key.match(/^(.+?):map\((.+)\)$/);
  if (mapMatch) {
    const val = String(flat[mapMatch[1]] || "");
    const mappings = {};
    mapMatch[2].split(",").forEach(pair => {
      const [from, to] = pair.split("=");
      if (from && to) mappings[from.trim()] = to.trim();
    });
    return mappings[val] || val;
  }

  if (key.includes(":")) {
    const [base, mod] = key.split(":");
    const val = String(flat[base] || "");
    if (!val) return "";

    // Date modifiers
    if (val.includes("-") && val.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y, m, d] = val.split("-");
      const dd = (d || "").slice(0, 2);
      if (mod === "year") return y;
      if (mod === "month") return m;
      if (mod === "day") return dd;
      if (mod === "jp") return `${y}年${parseInt(m)}月${parseInt(dd)}日`;
      if (mod === "slash") return `${y}/${m}/${dd}`;
      if (mod === "dot") return `${dd}.${m}.${y}`;
      if (mod === "dmy") return `${dd}/${m}/${y}`;
      if (mod === "mdy") return `${m}/${dd}/${y}`;
    }

    // Name modifiers
    if (mod === "first") { const parts = val.trim().split(/\s+/); return parts[0] || ""; }
    if (mod === "last") { const parts = val.trim().split(/\s+/); return parts.slice(1).join(" ") || ""; }

    // Built-in Japanese translations — short values
    if (mod === "jp") {
      const JP_MAP = {
        "Male": "男", "Female": "女", "Other": "その他",
        "Bangladeshi": "バングラデシュ", "Bangladesh": "バングラデシュ",
        "Single": "未婚", "Married": "既婚", "Divorced": "離婚", "Widowed": "寡婦",
        "A+": "A型(Rh+)", "A-": "A型(Rh-)", "B+": "B型(Rh+)", "B-": "B型(Rh-)",
        "AB+": "AB型(Rh+)", "AB-": "AB型(Rh-)", "O+": "O型(Rh+)", "O-": "O型(Rh-)",
        "Individual": "個人", "Company": "法人",
        "Science": "理系", "Commerce": "商業", "Arts": "文系",
      };
      // Short value → JP_MAP lookup
      if (JP_MAP[val]) return JP_MAP[val];
      // Long text → pre-translated cache check (base_jp key-তে রাখা হয়)
      if (flat[base + "_jp"]) return flat[base + "_jp"];
      // Date check — YYYY-MM-DD format হলে Japanese date-এ convert
      if (val.match(/^\d{4}-\d{2}-\d{2}/)) {
        const [y, m, d] = val.split("-");
        return `${y}年${parseInt(m)}月${parseInt((d || "").slice(0, 2))}日`;
      }
      return val;
    }

    return val;
  }
  return flat[key] ?? "";
}

module.exports = { resolveValue };
