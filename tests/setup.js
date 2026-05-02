/**
 * tests/setup.js — Jest global setup
 *
 * - Loads tests/.env.test if present (kept out of git via .gitignore).
 * - Falls back to safe test defaults for JWT_SECRET / ENCRYPTION_KEY so the app boots
 *   without a real .env file (e.g. in CI or on a fresh clone).
 * - Side-effect-only — exports nothing.
 */

const path = require("path");
const fs = require("fs");

const envPath = path.resolve(__dirname, ".env.test");
if (fs.existsSync(envPath)) {
  try {
    require("dotenv").config({ path: envPath });
  } catch {
    // dotenv may not be installed in some minimal CI images — fail silent.
  }
}

// Force NODE_ENV=test so the app's `isProduction` checks behave correctly.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// Test defaults — never use these in production. They're only here so middleware
// that demands JWT_SECRET / ENCRYPTION_KEY at require()-time doesn't crash.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "test-secret-do-not-use-in-prod-this-is-only-for-jest";
}
if (!process.env.ENCRYPTION_KEY) {
  // 64 hex chars = 32-byte AES-256 key
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000000";
}

// Quiet down Sentry's stderr noise during tests (no-op DSN check).
process.env.SENTRY_DSN = process.env.SENTRY_DSN || "";
