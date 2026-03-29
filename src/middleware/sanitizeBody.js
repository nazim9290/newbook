/**
 * sanitizeBody.js — Request Body Sanitizer Middleware
 *
 * PostgreSQL date/timestamp column-এ empty string ("") পাঠালে error দেয়।
 * এই middleware সব request body-তে:
 * - Empty string date values → null
 * - "undefined" string → null
 * - Trim whitespace from strings
 *
 * সব POST/PATCH route-এ automatic কাজ করবে।
 */

// Date-like field names — এগুলোতে "" → null হবে
const DATE_PATTERNS = [
  "date", "dob", "_at", "_date", "expiry", "issue", "deadline",
  "start_date", "end_date", "due_date", "paid_date", "join_date",
  "follow_up", "appointment", "submission_date", "result_date",
  "interview_date", "coe_date", "visa_date", "flight_date",
  "health_date", "tuition_date", "balance_date",
];

function isDateField(key) {
  const k = key.toLowerCase();
  return DATE_PATTERNS.some(p => k.includes(p) || k.endsWith(p));
}

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const [key, val] of Object.entries(req.body)) {
      // Empty string date → null
      if (val === "" && isDateField(key)) {
        req.body[key] = null;
      }
      // "undefined" string → remove
      if (val === "undefined" || val === "null") {
        req.body[key] = null;
      }
      // JSONB fields — array/object → JSON string (PostgreSQL JSONB expects string)
      // শুধু known JSONB field names-এ apply হবে
      const JSONB_FIELDS = ["fields", "settings", "permissions", "education", "fund_formation", "field_data", "mappings", "scores", "interested_countries"];
      if (Array.isArray(val) && JSONB_FIELDS.includes(key)) {
        req.body[key] = JSON.stringify(val);
      }
    }
  }
  next();
}

module.exports = sanitizeBody;
