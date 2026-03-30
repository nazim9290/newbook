/**
 * sanitizeBody.js — Global Request Body Sanitizer
 *
 * সব POST/PATCH request-এ automatic কাজ করে:
 * 1. Empty string date → null (PostgreSQL date column "" reject করে)
 * 2. JSONB fields: JS array/object → JSON.stringify (PostgreSQL JSONB expects string)
 * 3. "undefined"/"null" string → null
 * 4. text[] array fields → PostgreSQL array format
 *
 * app.use(sanitizeBody) — app.js-এ global middleware হিসেবে register
 */

// ── Date-like field patterns — এগুলোতে "" → null হবে ──
const DATE_PATTERNS = [
  "date", "dob", "_at", "_date", "expiry", "issue", "deadline",
  "start_date", "end_date", "due_date", "paid_date", "join_date",
  "follow_up", "appointment", "submission_date", "result_date",
  "interview_date", "coe_date", "visa_date", "flight_date",
  "health_date", "tuition_date", "balance_date", "last_recheck_date",
  "purchase_date", "next_follow_up", "last_follow_up", "visit_date",
  "passport_issue", "passport_expiry",
];

// ── JSONB columns — array/object → JSON.stringify ──
const JSONB_FIELDS = new Set([
  // agencies
  "id_counters", "settings",
  // batches
  // "settings" already above
  // class_tests
  "scores",
  // doc_templates
  "field_mappings", "placeholders",
  // doc_types
  "fields",
  // document_data
  "field_data",
  // documents
  "extracted_data",
  // excel_templates
  "mappings",
  // platform_settings
  "value",
  // portal_form_config
  // "fields" already above
  // sponsors
  "fund_formation",
  // students
  "portal_sections",
  // users
  "permissions",
  // visitors
  "education",
  // activity_log
  "old_value", "new_value",
  // generic
  "feedback",
]);

// ── text[] (PostgreSQL array) columns — JS array → PostgreSQL array literal ──
const TEXT_ARRAY_FIELDS = new Set([
  "interested_countries", "services", "intakes",
]);

function isDateField(key) {
  const k = key.toLowerCase();
  return DATE_PATTERNS.some(p => k === p || k.endsWith(p) || k.includes(p));
}

function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    for (const [key, val] of Object.entries(req.body)) {
      // 1. Empty string date → null
      if (val === "" && isDateField(key)) {
        req.body[key] = null;
        continue;
      }

      // 2. "undefined" / "null" string → null
      if (val === "undefined" || val === "null") {
        req.body[key] = null;
        continue;
      }

      // 3. JSONB fields — array/object → JSON.stringify
      if (JSONB_FIELDS.has(key) && val !== null && val !== undefined) {
        if (typeof val === "object") {
          req.body[key] = JSON.stringify(val);
        }
        // Already string → leave as-is (frontend may have pre-stringified)
        continue;
      }

      // 4. text[] fields — JS array → keep as-is (supabase client handles)
      // But if it's a string that looks like JSON array, parse it
      if (TEXT_ARRAY_FIELDS.has(key) && typeof val === "string" && val.startsWith("[")) {
        try { req.body[key] = JSON.parse(val); } catch {}
        continue;
      }
    }
  }
  next();
}

module.exports = sanitizeBody;
