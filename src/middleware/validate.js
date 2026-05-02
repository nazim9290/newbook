/**
 * validate.js — Zod schema validation middleware
 *
 * Usage:
 *   const { validate } = require("../middleware/validate");
 *   const { loginSchema } = require("../schemas/auth.schema");
 *   router.post("/login", validate(loginSchema), handler);
 *
 * On success: replaces req[source] with the parsed value (with coercions / defaults applied).
 * On failure: 400 with Bengali error + structured `issues` array.
 *
 * Sources allowed: 'body' (default), 'query', 'params'.
 */

const ALLOWED_SOURCES = new Set(["body", "query", "params"]);

function validate(schema, source = "body") {
  if (!schema || typeof schema.safeParse !== "function") {
    throw new Error("validate(): schema must be a Zod schema");
  }
  if (!ALLOWED_SOURCES.has(source)) {
    throw new Error(`validate(): source must be one of body|query|params, got "${source}"`);
  }

  return function validateMiddleware(req, res, next) {
    const input = req[source];
    const result = schema.safeParse(input);

    if (!result.success) {
      const issues = (result.error.issues || []).map((iss) => ({
        path: Array.isArray(iss.path) ? iss.path.join(".") : String(iss.path || ""),
        message: iss.message || "Invalid value",
      }));
      return res.status(400).json({
        error: "ভ্যালিডেশন ত্রুটি",
        code: "VALIDATION_ERROR",
        issues,
      });
    }

    // Replace with the parsed (coerced) value so downstream handlers get the typed shape.
    // For query/params, Express provides getters in some versions — assigning is safe in Express 4.
    try {
      req[source] = result.data;
    } catch {
      // If the property is read-only in some runtime, fall back to merging onto the original object.
      Object.assign(input || {}, result.data);
    }
    next();
  };
}

module.exports = { validate };
