#!/usr/bin/env node
/**
 * run-migrations.js — Phase 10: idempotent migration runner.
 *
 * Replaces the bash glob `for m in deploy/migration_*.sql; do psql ... done`
 * with a tracked migration system:
 *
 *   1. Tracks applied migrations in a `_migrations` table (filename + checksum)
 *   2. Skips already-applied (matching checksum)
 *   3. ERRORS if file content changed since application (drift detection)
 *   4. Applies in alphabetical order
 *   5. Wraps each migration in a transaction — partial failures auto-rollback
 *
 * Usage:
 *   node scripts/run-migrations.js              # apply all pending
 *   node scripts/run-migrations.js --dry-run    # show what would run
 *   node scripts/run-migrations.js --status     # list applied + pending
 *
 * ENV: DATABASE_URL (read from .env)
 *
 * Used by:
 *   - safe-update.sh (Phase 2) — automatic on update
 *   - provision-dedicated.sh (Phase 1) — initial DB setup
 *   - manual recovery
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '../deploy');
const TRACK_TABLE = '_migrations';

function args() {
  const a = process.argv.slice(2);
  return {
    dryRun: a.includes('--dry-run'),
    status: a.includes('--status'),
  };
}

function checksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function ensureTrackTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACK_TABLE} (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now(),
      applied_by TEXT
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(
    `SELECT filename, checksum, applied_at FROM ${TRACK_TABLE} ORDER BY filename`
  );
  return new Map(rows.map(r => [r.filename, r]));
}

function listMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^migration_.*\.sql$/.test(f))
    .sort();
  return files.map(name => {
    const fullPath = path.join(MIGRATIONS_DIR, name);
    const content = fs.readFileSync(fullPath, 'utf8');
    return { name, content, sum: checksum(content), path: fullPath };
  });
}

async function main() {
  const { dryRun, status } = args();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await ensureTrackTable(client);
    const applied = await getApplied(client);
    const files = listMigrationFiles();

    if (status) {
      console.log('Migrations status:');
      for (const f of files) {
        const a = applied.get(f.name);
        if (!a) {
          console.log(`  [PENDING] ${f.name}`);
        } else if (a.checksum !== f.sum) {
          console.log(`  [DRIFT!]  ${f.name}  applied=${a.checksum} disk=${f.sum}`);
        } else {
          console.log(`  [APPLIED] ${f.name}  ${a.applied_at}`);
        }
      }
      const pending = files.filter(f => !applied.has(f.name));
      console.log(`\n${applied.size} applied, ${pending.length} pending, ${files.length} total`);
      return;
    }

    const drift = files.filter(f => applied.has(f.name) && applied.get(f.name).checksum !== f.sum);
    if (drift.length > 0) {
      console.error('FATAL: drift detected in already-applied migrations:');
      drift.forEach(f => console.error(`  ${f.name}`));
      console.error('\nNever modify a migration file after it has been applied.');
      console.error('Add a new migration to fix the schema instead.');
      process.exit(2);
    }

    const pending = files.filter(f => !applied.has(f.name));
    if (pending.length === 0) {
      console.log('All migrations already applied.');
      return;
    }

    console.log(`${pending.length} pending migration(s) to apply:`);
    pending.forEach(f => console.log(`  - ${f.name}`));

    if (dryRun) {
      console.log('\n--dry-run — nothing applied');
      return;
    }

    for (const m of pending) {
      console.log(`\n→ Applying ${m.name} ...`);
      try {
        await client.query('BEGIN');
        await client.query(m.content);
        await client.query(
          `INSERT INTO ${TRACK_TABLE} (filename, checksum, applied_by) VALUES ($1, $2, $3)`,
          [m.name, m.sum, process.env.USER || 'unknown']
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${m.name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  ✗ ${m.name}: ${err.message}`);
        console.error('Aborting — fix the migration and re-run.');
        process.exit(3);
      }
    }
    console.log(`\n✓ ${pending.length} migration(s) applied successfully`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
