/**
 * lib/storage/mirror.js — dual-write storage backend (VPS local + R2)
 *
 * Activation: STORAGE_BACKEND=mirror in .env (R2 credentials must also be set).
 *
 * Semantics:
 *   put(key, buffer)
 *     1. Write to LOCAL — must succeed (this is the source of truth for reads)
 *     2. Write to R2    — best-effort. If R2 fails, log + continue.
 *        Failed mirror is logged with [mirror:drift] tag so reconciliation
 *        can pick it up later.
 *
 *   get(key)
 *     1. Try LOCAL — fastest, free, no egress cost
 *     2. If local miss → try R2 → if hit, write back to local (self-heal)
 *     This means a wiped local disk is automatically rebuilt on first
 *     access of each file.
 *
 *   del(key)
 *     Best-effort delete from BOTH backends. Either failing does NOT
 *     abort the other — we'd rather over-delete than leak.
 *
 *   exists(key)
 *     Checks local OR r2 (any hit returns true).
 *
 * Why this shape:
 *   - Reads stay fast and free (local disk)
 *   - Writes are doubled, but xlsx/docx are small (avg <500 KB) — R2
 *     upload completes in ~100-300ms, well within an HTTP request budget
 *   - Local disk crash → R2 still has everything; first request rebuilds
 *     the local copy
 *   - R2 outage → local writes keep working; pending mirror operations
 *     surface in logs, replayed via scripts/storage-reconcile.js
 *
 * For Enterprise:
 *   - Same code path supports "shift to R2-primary": simply set
 *     STORAGE_BACKEND=r2 (skips local entirely) — no schema/data change
 *   - Add a CDN in front of R2 (Cloudflare native) for global read speed
 *   - Run scripts/storage-reconcile.js as a nightly cron to catch drift
 */

const local = require("./local");
const r2 = require("./r2");

async function put(key, buffer) {
  // Step 1: LOCAL — primary, must succeed
  await local.put(key, buffer);

  // Step 2: R2 — secondary, best-effort
  try {
    await r2.put(key, buffer);
  } catch (e) {
    console.error(`[mirror:drift] R2 put failed for "${key}": ${e.message} — local saved OK, R2 will be reconciled later`);
  }

  return key;
}

async function get(key) {
  if (!key) return null;

  // Try LOCAL first (fast path)
  let buf;
  try { buf = await local.get(key); } catch (e) { console.warn("[mirror] local.get error:", e.message); }
  if (buf) return buf;

  // LOCAL miss → try R2 fallback (self-heal: cache back to local)
  try {
    const r2Buf = await r2.get(key);
    if (r2Buf) {
      console.warn(`[mirror:rebuild] "${key}" missing locally, restored from R2 (${r2Buf.length} bytes)`);
      try { await local.put(key, r2Buf); } catch (e) { console.warn("[mirror] self-heal put failed:", e.message); }
      return r2Buf;
    }
  } catch (e) {
    console.error(`[mirror] R2 get failed for "${key}": ${e.message}`);
  }

  return null;
}

async function del(key) {
  if (!key) return;
  // Both deletes attempted — partial failure is logged but doesn't propagate.
  // Rationale: leaving a stale file on either side is worse than a transient error.
  let localErr, r2Err;
  try { await local.del(key); } catch (e) { localErr = e.message; }
  try { await r2.del(key); } catch (e) { r2Err = e.message; }
  if (localErr) console.warn(`[mirror] local.del("${key}") failed: ${localErr}`);
  if (r2Err) console.warn(`[mirror:drift] r2.del("${key}") failed: ${r2Err}`);
}

async function exists(key) {
  if (!key) return false;
  if (await local.exists(key)) return true;
  try { return await r2.exists(key); } catch { return false; }
}

function resolve(key) {
  // Mirror falls back to local resolution — used by routes that need a
  // direct filesystem path (e.g. for child_process spawns reading the file).
  return local.resolve(key);
}

function ensureDirs() {
  local.ensureDirs();
  // R2 has no directories — no-op
}

module.exports = {
  put, get, del, exists, resolve, ensureDirs,
  kind: "mirror",
  local, r2, // expose for diagnostics / reconciliation
  UPLOADS_DIR: local.UPLOADS_DIR,
  BUCKET: r2.BUCKET,
};
