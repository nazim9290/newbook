/**
 * lib/storage/local.js — local-filesystem storage backend
 *
 * Single source of truth for the upload base directory:
 *   process.env.UPLOADS_DIR  (preferred — set in .env / pm2 ecosystem)
 *   fallback: <backend>/uploads
 *
 * On VPS we symlink <backend>/uploads → /home/agencybook/uploads so that
 * git pulls and PM2 restarts can never wipe the uploaded files.
 *
 * Public API (matches r2.js for swappability):
 *   put(key, buffer)   → writes file, returns the key
 *   get(key)           → returns Buffer or null (with legacy-path fallbacks)
 *   del(key)           → deletes file (silent if missing)
 *   exists(key)        → boolean
 *   resolve(key)       → absolute filesystem path for the key
 *
 * "key" is always a forward-slash relative path like:
 *   excel-templates/<agency>_<ts>_<orig>.xlsx
 *   doc-templates/<agency>_<ts>_<orig>.docx
 */

const fs = require("fs");
const path = require("path");

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../../../uploads");

// Subdirs the app expects to exist. ensureDirs() runs once at boot.
const STANDARD_SUBDIRS = ["excel-templates", "doc-templates", "interview-templates", "ocr-temp", "tmp"];

function ensureDirs() {
  for (const sub of [".", ...STANDARD_SUBDIRS]) {
    const p = path.join(UPLOADS_DIR, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function resolveKey(key) {
  // Reject absolute paths or path traversal — keys must stay inside UPLOADS_DIR
  if (path.isAbsolute(key) || key.includes("..")) return null;
  return path.join(UPLOADS_DIR, key);
}

async function put(key, buffer) {
  const full = resolveKey(key);
  if (!full) throw new Error("invalid storage key: " + key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return key;
}

// Read with legacy-path fallbacks. "key" may be:
//   1. a clean relative key (preferred — new uploads)
//   2. an absolute path (old DB rows from before this refactor)
//   3. a basename only (very old root-uploaded files)
async function get(key) {
  if (!key) return null;

  // Case 1: clean relative key under UPLOADS_DIR
  const direct = resolveKey(key);
  if (direct && fs.existsSync(direct)) return fs.readFileSync(direct);

  // Case 2: stale absolute path stored at upload-time
  if (path.isAbsolute(key) && fs.existsSync(key)) {
    console.warn("[storage/local] absolute-path fallback used for:", key);
    return fs.readFileSync(key);
  }

  // Case 3: fall back to basename in standard subdirs and uploads root
  const base = path.basename(key);
  const candidates = [
    ...STANDARD_SUBDIRS.map(s => path.join(UPLOADS_DIR, s, base)),
    path.join(UPLOADS_DIR, base),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.warn("[storage/local] basename fallback used:", p, "(was:", key, ")");
      return fs.readFileSync(p);
    }
  }

  return null;
}

async function del(key) {
  const full = resolveKey(key);
  if (full && fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch {}
    return;
  }
  // Legacy absolute path
  if (path.isAbsolute(key) && fs.existsSync(key)) {
    try { fs.unlinkSync(key); } catch {}
  }
}

async function exists(key) {
  const full = resolveKey(key);
  if (full && fs.existsSync(full)) return true;
  if (path.isAbsolute(key) && fs.existsSync(key)) return true;
  return false;
}

function resolve(key) {
  return resolveKey(key);
}

module.exports = { put, get, del, exists, resolve, ensureDirs, UPLOADS_DIR, kind: "local" };
