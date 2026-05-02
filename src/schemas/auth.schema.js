/**
 * auth.schema.js — Zod schemas for /api/auth/*
 *
 * Use with:
 *   const { validate } = require("../middleware/validate");
 *   const { loginSchema } = require("../schemas/auth.schema");
 *   router.post("/login", validate(loginSchema), handler);
 */

const { z } = require("zod");

// Common primitives
const emailField = z.string().trim().toLowerCase().email("সঠিক email দিন");
const passwordField = z
  .string()
  .min(1, "Password দিন")
  .max(200, "Password অনেক বড় — ছোট করুন");

// POST /api/auth/login — { email, password }
const loginSchema = z
  .object({
    email: emailField,
    password: passwordField,
  })
  .strict();

// POST /api/auth/refresh — placeholder for future refresh-token flow
// Currently auth.js doesn't expose a /refresh endpoint, but the schema is pre-defined
// so the rollout is just a one-line wiring change when the route lands.
const refreshSchema = z
  .object({
    refresh_token: z.string().min(10).optional(),
  })
  .strict();

// POST /api/auth/2fa/setup-verify and /verify — { token: 6-digit }
// Brief calls this register2FASchema.
const register2FASchema = z
  .object({
    token: z
      .string()
      .regex(/^\d{6}$/, "৬ digit কোড দিন"),
    // Some flows ship a backup code instead of a TOTP — accept optionally.
    backup_code: z
      .string()
      .regex(/^[A-Z0-9-]{8,16}$/i, "ব্যাকআপ কোড ভুল")
      .optional(),
  })
  .strict();

module.exports = {
  loginSchema,
  refreshSchema,
  register2FASchema,
};
