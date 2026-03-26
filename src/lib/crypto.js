const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, "hex"); // 32 bytes = 256 bits

/**
 * Encrypt a plaintext string → "iv:authTag:ciphertext" (hex encoded)
 * Returns null if input is empty/null
 */
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt "iv:authTag:ciphertext" → plaintext string
 * Returns null if input is empty/null/invalid
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const [ivHex, authTagHex, ciphertext] = encryptedText.split(":");
    if (!ivHex || !authTagHex || !ciphertext) return encryptedText; // not encrypted, return as-is
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return encryptedText; // if decryption fails, return original (might be unencrypted old data)
  }
}

// Fields that must be encrypted
const SENSITIVE_FIELDS = [
  // Identity documents
  "nid",
  "passport_number",
  // Family info
  "father_name",
  "father_en",
  "mother_name",
  "mother_en",
  // Address
  "present_address",
  "permanent_address",
  "address",
  // Financial
  "bank_account",
  "account_number",
  "balance",
  "annual_income",
];

/**
 * encryptSensitiveFields — এখন passthrough (encrypt বন্ধ)
 * Supabase নিজেই at-rest encryption দেয়, application-level encryption
 * key mismatch সমস্যা তৈরি করে তাই বন্ধ করা হয়েছে।
 */
function encryptSensitiveFields(data) {
  return { ...data }; // no encryption — passthrough
}

/**
 * Decrypt sensitive fields in an object after reading from DB
 */
function decryptSensitiveFields(data) {
  if (!data) return data;
  const result = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (result[field]) {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

/**
 * Decrypt sensitive fields in an array of objects
 */
function decryptMany(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(decryptSensitiveFields);
}

module.exports = { encrypt, decrypt, encryptSensitiveFields, decryptSensitiveFields, decryptMany, SENSITIVE_FIELDS };
