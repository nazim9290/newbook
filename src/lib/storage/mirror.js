/**
 * lib/storage/mirror.js — dual-write storage backend (VPS local + R2)
 *
 * Activation: STORAGE_BACKEND=mirror in .env.
 *
 * Agency-aware (Phase 3 — BYOK R2 buckets):
 *   - Local FS is always the platform's VPS (never BYOK — that disk is yours,
 *     not the agency's)
 *   - R2 is BYOK-aware via lib/integrations resolver:
 *       - Agency has BYOK R2 creds → mirror to THEIR bucket
 *       - Shared instance, no BYOK   → mirror to platform R2 (with quota)
 *       - Enterprise instance, no BYOK → R2 mirror skipped silently
 *         (local-only, owner can configure later)
 *
 * Semantics:
 *   put(key, buffer, agencyId)
 *     1. Write LOCAL — must succeed
 *     2. Write R2 (agency or platform) — best-effort
 *
 *   get(key, agencyId)
 *     1. LOCAL first
 *     2. LOCAL miss → try R2 (agency-aware) → on hit, write back to local
 *
 *   del(key, agencyId)
 *     Best-effort delete from both stores.
 *
 *   exists(key, agencyId)
 *     LOCAL OR R2 (any-hit returns true).
 */

const local = require("./local");
const r2 = require("./r2");

async function put(key, buffer, agencyId) {
  // 1. LOCAL — primary, must succeed
  await local.put(key, buffer);

  // 2. R2 — secondary, best-effort. If agency lacks R2 creds and platform
  //    is unavailable, r2.put will throw — we catch and log.
  try {
    await r2.put(key, buffer, agencyId);
  } catch (e) {
    console.error(`[mirror:drift] R2 put failed for "${key}" (agency=${agencyId || "platform"}): ${e.message} — local saved OK`);
  }

  return key;
}

async function get(key, agencyId) {
  if (!key) return null;

  let buf;
  try { buf = await local.get(key); } catch (e) { console.warn("[mirror] local.get error:", e.message); }
  if (buf) return buf;

  try {
    const r2Buf = await r2.get(key, agencyId);
    if (r2Buf) {
      console.warn(`[mirror:rebuild] "${key}" missing locally, restored from R2 (agency=${agencyId || "platform"}, ${r2Buf.length} bytes)`);
      try { await local.put(key, r2Buf); } catch (e) { console.warn("[mirror] self-heal put failed:", e.message); }
      return r2Buf;
    }
  } catch (e) {
    console.error(`[mirror] R2 get failed for "${key}": ${e.message}`);
  }

  return null;
}

async function del(key, agencyId) {
  if (!key) return;
  let localErr, r2Err;
  try { await local.del(key); } catch (e) { localErr = e.message; }
  try { await r2.del(key, agencyId); } catch (e) { r2Err = e.message; }
  if (localErr) console.warn(`[mirror] local.del("${key}") failed: ${localErr}`);
  if (r2Err) console.warn(`[mirror:drift] r2.del("${key}", agency=${agencyId || "platform"}) failed: ${r2Err}`);
}

async function exists(key, agencyId) {
  if (!key) return false;
  if (await local.exists(key)) return true;
  try { return await r2.exists(key, agencyId); } catch { return false; }
}

function resolve(key) {
  return local.resolve(key);
}

function ensureDirs() {
  local.ensureDirs();
}

module.exports = {
  put, get, del, exists, resolve, ensureDirs,
  kind: "mirror",
  local, r2,
  UPLOADS_DIR: local.UPLOADS_DIR,
  BUCKET: r2.BUCKET,
};
