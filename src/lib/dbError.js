/**
 * dbError.js — Database Error Response Helper
 *
 * DB error হলে:
 * - Development: real error message দেখায় (debug সহজ)
 * - Production: generic message দেখায় (security)
 * - সব সময় console-এ log করে
 */

const isDev = process.env.NODE_ENV !== "production";

/**
 * DB error response পাঠাও
 * @param {object} res - Express response
 * @param {object} error - DB error object { message }
 * @param {string} context - কোথায় error হয়েছে (debug log-এর জন্য)
 * @param {number} status - HTTP status code (default 400)
 */
function dbError(res, error, context = "", status = 400) {
  const msg = error?.message || "Unknown error";
  console.error(`[DB Error] ${context}:`, msg);

  // Client-এ কখনো raw DB error পাঠানো যাবে না — শুধু generic message
  return res.status(status).json({ error: "সার্ভার ত্রুটি — পরে আবার চেষ্টা করুন" });
}

/**
 * Numeric field sanitize — string "50000" → number 50000, empty → null
 */
function toNum(val) {
  if (val === "" || val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

/**
 * Object-এর নির্দিষ্ট keys গুলো numeric-এ convert করো
 */
function sanitizeNumerics(obj, keys) {
  const result = { ...obj };
  for (const key of keys) {
    if (key in result) result[key] = toNum(result[key]);
  }
  return result;
}

module.exports = { dbError, toNum, sanitizeNumerics };
