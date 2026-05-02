/**
 * lib/storage/local.js — local-filesystem storage backend
 *
 * Always platform-owned (the VPS where the backend runs). In shared mode
 * this is the SaaS provider's VPS; in enterprise mode it's the customer's
 * own VPS. Either way it's NOT BYOK — the agencyId argument is accepted
 * for API parity but doesn't change behavior.
 *
 * UPLOADS_DIR (env) — base directory. Default: <backend>/uploads.
 * On VPS we set it to /home/agencybook/uploads (outside deploy dir).
 *
 * Public API (matches r2.js for swappability):
 *   put(key, buffer, _agencyId?)
 *   get(key, _agencyId?)         with legacy-path fallbacks
 *   del(key, _agencyId?)
 *   exists(key, _agencyId?)
 *   resolve(key)                 absolute filesystem path
 *
 * Keys are forward-slash relative paths like:
 *   excel-templates/<agency>_<ts>_<orig>.xlsx
 *   doc-templates/<agency>_<ts>_<orig>.docx
 */

const fs = require("fs");
const path = require("path");

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../../../uploads");

const STANDARD_SUBDIRS = ["excel-templates", "doc-templates", "interview-templates", "ocr-temp", "tmp"];

function ensureDirs() {
  for (const sub of [".", ...STANDARD_SUBDIRS]) {
    const p = path.join(UPLOADS_DIR, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function resolveKey(key) {
  if (path.isAbsolute(key) || key.includes("..")) return null;
  return path.join(UPLOADS_DIR, key);
}

async function put(key, buffer, _agencyId) {
  const full = resolveKey(key);
  if (!full) throw new Error("invalid storage key: " + key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return key;
}

async function get(key, _agencyId) {
  if (!key) return null;

  const direct = resolveKey(key);
  if (direct && fs.existsSync(direct)) return fs.readFileSync(direct);

  if (path.isAbsolute(key) && fs.existsSync(key)) {
    console.warn("[storage/local] absolute-path fallback used for:", key);
    return fs.readFileSync(key);
  }

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

async function del(key, _agencyId) {
  const full = resolveKey(key);
  if (full && fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch {}
    return;
  }
  if (path.isAbsolute(key) && fs.existsSync(key)) {
    try { fs.unlinkSync(key); } catch {}
  }
}

async function exists(key, _agencyId) {
  const full = resolveKey(key);
  if (full && fs.existsSync(full)) return true;
  if (path.isAbsolute(key) && fs.existsSync(key)) return true;
  return false;
}

function resolve(key) {
  return resolveKey(key);
}

module.exports = { put, get, del, exists, resolve, ensureDirs, UPLOADS_DIR, kind: "local" };
