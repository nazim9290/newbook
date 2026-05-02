/**
 * lib/storage/index.js — storage backend facade
 *
 * Picks the right backend based on STORAGE_BACKEND env var:
 *   "local" (default) → lib/storage/local.js  (filesystem, with legacy fallbacks)
 *   "r2"              → lib/storage/r2.js     (Cloudflare R2 S3-compatible)
 *
 * Routes import from this module ONLY — they never touch fs or aws-sdk
 * directly. To switch backends in production, change STORAGE_BACKEND in
 * .env and restart PM2 — no code change needed.
 *
 * To migrate existing files from local → R2:
 *   node scripts/migrate-uploads-to-r2.js
 */

const backendName = (process.env.STORAGE_BACKEND || "local").toLowerCase();

let backend;
if (backendName === "r2") {
  backend = require("./r2");
} else {
  backend = require("./local");
}

console.log(`[storage] backend = ${backend.kind}${backend.kind === "local" ? ` (UPLOADS_DIR=${backend.UPLOADS_DIR})` : ` (bucket=${backend.BUCKET})`}`);

module.exports = backend;
