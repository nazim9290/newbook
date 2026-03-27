/**
 * idGenerator.js — Agency-wise Prefixed ID Generator
 *
 * এজেন্সির নামের আদ্যক্ষর দিয়ে unique prefix তৈরি করে।
 * প্রতিটি entity (student, visitor, payment) এর জন্য sequential ID generate করে।
 *
 * Format: {PREFIX}-{TYPE}-{YEAR}-{SEQ}
 * Example: SEC-S-2026-001, SEC-V-2026-015, DLA-P-2026-042
 *
 * TYPE codes:
 *   S = Student, V = Visitor, P = Payment, INV = Invoice, SUB = Submission
 */

const supabase = require("./supabase");

// ═══════════════════════════════════════════════════════
// Prefix Generator — এজেন্সির নাম থেকে 2-4 অক্ষরের prefix
// ═══════════════════════════════════════════════════════

/**
 * নাম থেকে prefix তৈরি করো
 * "Sunrise Education Consultancy" → "SEC"
 * "Dhaka Language Academy" → "DLA"
 * "ABC International" → "ABCI"
 * "Tokyo" → "TOK"
 */
function generatePrefix(name) {
  if (!name) return "AGN";

  // বাংলা নাম হলে English name ব্যবহার করতে হবে — fallback
  // non-ASCII characters বাদ দাও
  const clean = name.replace(/[^\x20-\x7E]/g, "").trim();
  if (!clean) return "AGN";

  const words = clean.split(/[\s\-_&]+/).filter(w => w.length > 0);

  let prefix = "";

  if (words.length >= 3) {
    // ৩+ শব্দ → প্রতিটি শব্দের প্রথম অক্ষর: "Sunrise Education Consultancy" → "SEC"
    prefix = words.map(w => w[0]).join("").toUpperCase().slice(0, 4);
  } else if (words.length === 2) {
    // ২ শব্দ → প্রথম শব্দের ২ অক্ষর + দ্বিতীয় শব্দের ১ অক্ষর: "Dhaka Language" → "DHL"
    prefix = (words[0].slice(0, 2) + words[1][0]).toUpperCase();
  } else {
    // ১ শব্দ → প্রথম ৩ অক্ষর: "Tokyo" → "TOK"
    prefix = words[0].slice(0, 3).toUpperCase();
  }

  // কমপক্ষে ২ অক্ষর নিশ্চিত করো
  if (prefix.length < 2) prefix = (prefix + "XX").slice(0, 3);

  return prefix;
}

/**
 * Unique prefix নিশ্চিত করো — duplicate হলে শেষে number যোগ করো
 * "SEC" → exists? → "SEC2" → exists? → "SEC3"
 */
async function ensureUniquePrefix(basePrefix) {
  let prefix = basePrefix;
  let attempt = 1;

  while (true) {
    const { data } = await supabase.from("agencies").select("id").eq("prefix", prefix).single();
    if (!data) return prefix; // unique পাওয়া গেছে

    attempt++;
    prefix = basePrefix.slice(0, 3) + attempt; // SEC2, SEC3...
    if (attempt > 99) {
      // fallback — random suffix
      prefix = basePrefix.slice(0, 2) + Math.random().toString(36).slice(2, 4).toUpperCase();
      break;
    }
  }

  return prefix;
}

// ═══════════════════════════════════════════════════════
// ID Generator — entity type অনুযায়ী sequential ID
// ═══════════════════════════════════════════════════════

// Type code mapping
const TYPE_CODES = {
  student: "S",
  visitor: "V",
  payment: "P",
  invoice: "INV",
  submission: "SUB",
};

/**
 * নতুন ID generate করো
 * @param {string} agencyId — agency UUID
 * @param {string} type — "student" | "visitor" | "payment" | "invoice" | "submission"
 * @returns {string} — "SEC-S-2026-001"
 *
 * Atomic operation: counter increment + ID return একসাথে হয়
 * (concurrent request-এ duplicate হবে না)
 */
async function generateId(agencyId, type) {
  const pool = supabase.pool;
  const typeCode = TYPE_CODES[type] || type.slice(0, 3).toUpperCase();
  const year = new Date().getFullYear();

  // Atomic counter increment — PostgreSQL JSONB update
  // id_counters->>'student' কে ১ বাড়াও এবং নতুন value return করো
  const { rows } = await pool.query(`
    UPDATE agencies
    SET id_counters = jsonb_set(
      COALESCE(id_counters, '{}'),
      $2,
      to_jsonb((COALESCE((id_counters->>$3)::int, 0) + 1))
    ),
    updated_at = now()
    WHERE id = $1
    RETURNING prefix, (id_counters->>$3)::int AS seq
  `, [agencyId, `{${type}}`, type]);

  if (!rows[0]) {
    // Agency পাওয়া যায়নি — fallback ID
    return `AGN-${typeCode}-${year}-${String(Date.now()).slice(-4)}`;
  }

  const { prefix, seq } = rows[0];
  const paddedSeq = String(seq).padStart(3, "0");

  return `${prefix || "AGN"}-${typeCode}-${year}-${paddedSeq}`;
}

/**
 * Bulk ID generate (Excel import এর জন্য)
 * @param {string} agencyId
 * @param {string} type
 * @param {number} count — কতগুলো ID দরকার
 * @returns {string[]} — ["SEC-S-2026-001", "SEC-S-2026-002", ...]
 */
async function generateBulkIds(agencyId, type, count) {
  const pool = supabase.pool;
  const typeCode = TYPE_CODES[type] || type.slice(0, 3).toUpperCase();
  const year = new Date().getFullYear();

  // Atomic: counter কে count বাড়াও, starting seq return করো
  const { rows } = await pool.query(`
    UPDATE agencies
    SET id_counters = jsonb_set(
      COALESCE(id_counters, '{}'),
      $2,
      to_jsonb((COALESCE((id_counters->>$3)::int, 0) + $4))
    ),
    updated_at = now()
    WHERE id = $1
    RETURNING prefix, (COALESCE((id_counters->>$3)::int, 0)) AS end_seq
  `, [agencyId, `{${type}}`, type, count]);

  if (!rows[0]) return Array.from({ length: count }, (_, i) => `AGN-${typeCode}-${year}-${String(i + 1).padStart(3, "0")}`);

  const { prefix, end_seq } = rows[0];
  const startSeq = end_seq - count + 1;

  return Array.from({ length: count }, (_, i) => {
    const seq = String(startSeq + i).padStart(3, "0");
    return `${prefix || "AGN"}-${typeCode}-${year}-${seq}`;
  });
}

module.exports = { generatePrefix, ensureUniquePrefix, generateId, generateBulkIds, TYPE_CODES };
