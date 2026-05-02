/**
 * lib/storage/index.js — storage backend facade
 *
 * Picks the right backend based on STORAGE_BACKEND env var:
 *   "local"  (default)  → filesystem only (lib/storage/local.js)
 *   "r2"                → Cloudflare R2 only (lib/storage/r2.js)
 *   "mirror"            → dual-write: local primary + R2 secondary
 *                         (lib/storage/mirror.js — recommended for production)
 *
 * Routes import from this module ONLY — they never touch fs or aws-sdk
 * directly. To switch backends, change STORAGE_BACKEND in .env and
 * restart PM2 — no code change needed.
 *
 * Operational scripts:
 *   scripts/migrate-uploads-to-r2.js   — one-time bulk seed local → R2
 *   scripts/storage-reconcile.js       — periodic drift detection / repair
 */

const backendName = (process.env.STORAGE_BACKEND || "local").toLowerCase();

let backend;
if (backendName === "r2") backend = require("./r2");
else if (backendName === "mirror") backend = require("./mirror");
else backend = require("./local");

// Boot-time log — verifies env is read correctly and backend chose right
let detail = "";
if (backend.kind === "local") detail = `UPLOADS_DIR=${backend.UPLOADS_DIR}`;
else if (backend.kind === "r2") detail = `bucket=${backend.BUCKET}`;
else if (backend.kind === "mirror") detail = `local=${backend.UPLOADS_DIR}, r2=${backend.BUCKET}`;
console.log(`[storage] backend = ${backend.kind} (${detail})`);

module.exports = backend;
