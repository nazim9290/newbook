#!/usr/bin/env node
/**
 * migrate.js — apply pending SQL migrations from deploy/*.sql.
 *
 * Usage:
 *   node scripts/migrate.js [--dry-run] [--force=<filename>]
 *
 *   --dry-run        list pending migrations, don't apply
 *   --force=name     re-run a specific migration even if already applied
 *
 * What it does:
 *   1. Ensures schema_migrations table exists (bootstrap)
 *   2. Lists deploy/migration_*.sql alphabetically
 *   3. For each: skip if filename already in schema_migrations (unless --force)
 *   4. Apply the file as a single SQL statement; on success, INSERT row
 *   5. Stops on first failure
 *
 * Connection: reads DATABASE_URL from .env (loaded via lib/db). Uses the
 * existing pg pool, so the same role + permissions as the running app.
 *
 * Cluster-safe: takes a PG advisory lock so two concurrent runs serialize.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { pool } = require("../src/lib/db");

const ADVISORY_LOCK_KEY = 9876500099n; // arbitrary, unlikely to collide

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceArg = argv.find(a => a.startsWith("--force="));
const forceFile = forceArg ? forceArg.split("=")[1] : null;

const DEPLOY_DIR = path.join(__dirname, "..", "deploy");
const APPLIED_BY = process.env.USER || process.env.USERNAME || "manual";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function ensureBootstrap(client) {
  // Bootstrap: create schema_migrations if it doesn't exist. We can't rely
  // on the migration file to exist on this box yet, so inline the DDL.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename     TEXT PRIMARY KEY,
      checksum     TEXT,
      applied_at   TIMESTAMPTZ DEFAULT now(),
      applied_by   TEXT
    )
  `);
}

async function getApplied(client) {
  const r = await client.query("SELECT filename, checksum FROM schema_migrations");
  const map = new Map();
  for (const row of r.rows) map.set(row.filename, row.checksum);
  return map;
}

function listMigrationFiles() {
  return fs.readdirSync(DEPLOY_DIR)
    .filter(f => /^migration_.*\.sql$/.test(f))
    .sort();
}

async function applyOne(client, filename) {
  const fullPath = path.join(DEPLOY_DIR, filename);
  const sql = fs.readFileSync(fullPath, "utf8");
  const checksum = sha256(sql);

  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO UPDATE
         SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = EXCLUDED.applied_by`,
      [filename, checksum, APPLIED_BY]
    );
    await client.query("COMMIT");
    return { ok: true, checksum };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, error: err.message };
  }
}

async function main() {
  const client = await pool.connect();
  try {
    // Acquire advisory lock so concurrent migrate runs don't race
    const locked = await client.query("SELECT pg_try_advisory_lock($1) AS got", [ADVISORY_LOCK_KEY]);
    if (!locked.rows[0].got) {
      console.error("[migrate] another migration run is in progress (advisory lock held)");
      process.exit(2);
    }

    await ensureBootstrap(client);
    const applied = await getApplied(client);
    const files = listMigrationFiles();

    const pending = files.filter(f => forceFile === f || !applied.has(f));
    const skipped = files.filter(f => applied.has(f) && f !== forceFile);

    console.log(`[migrate] ${files.length} files in deploy/`);
    console.log(`[migrate] ${applied.size} already applied`);
    console.log(`[migrate] ${pending.length} pending${forceFile ? ` (--force=${forceFile})` : ""}`);

    if (pending.length === 0) {
      console.log("[migrate] nothing to do");
      return;
    }

    if (dryRun) {
      console.log("\n[migrate] --dry-run pending list:");
      pending.forEach(f => console.log(`  - ${f}`));
      return;
    }

    for (const f of pending) {
      process.stdout.write(`[migrate] applying ${f} ... `);
      const result = await applyOne(client, f);
      if (result.ok) {
        console.log("OK");
      } else {
        console.log(`FAILED\n[migrate] error: ${result.error}`);
        console.log("[migrate] stopping. Fix the migration and re-run.");
        process.exit(1);
      }
    }

    console.log(`\n[migrate] done — ${pending.length} applied, ${skipped.length} skipped`);
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]); } catch { /* ignore */ }
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("[migrate] fatal:", err.message);
  process.exit(1);
});
