#!/usr/bin/env node
/**
 * seed-initial-tenant.js — Phase 1 helper.
 *
 * After a fresh per-tenant DB has been provisioned (schema + migrations + license),
 * this script creates ONE agency row + ONE owner user — the tenant's starting state.
 *
 * Idempotent: re-running with same --slug detects existing rows and prints them
 * instead of creating duplicates.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... \
 *   node scripts/seed-initial-tenant.js \
 *     --slug acme \
 *     --agency-name "Acme Education" \
 *     --agency-name-bn "অ্যাকমে এডুকেশন" \
 *     --admin-name "MD Rahim Khan" \
 *     --admin-email rahim@acme-edu.com \
 *     --admin-password "<temp-password>"
 *
 * Output (stdout): JSON summary with agency_id, user_id, login URL.
 *                  provision-dedicated.sh parses this.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabase = require('../src/lib/db');
const bcrypt = require('bcryptjs');
const { generatePrefix, ensureUniquePrefix } = require('../src/lib/idGenerator');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) { args[key] = true; }
      else { args[key] = val; i++; }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const slug = args.slug;
  const agencyName = args['agency-name'] || `Agency ${slug}`;
  const agencyNameBn = args['agency-name-bn'] || agencyName;
  const adminName = args['admin-name'] || 'Admin';
  const adminEmail = args['admin-email'];
  const adminPassword = args['admin-password'];
  const phone = args.phone || null;
  const address = args.address || null;

  if (!slug || !adminEmail || !adminPassword) {
    console.error('ERROR: --slug, --admin-email, and --admin-password are required');
    process.exit(1);
  }
  if (adminPassword.length < 8) {
    console.error('ERROR: --admin-password must be at least 8 characters');
    process.exit(1);
  }

  const pool = supabase.pool;

  // 1. Idempotency — does the agency already exist?
  const { rows: existingAgencies } = await pool.query(
    'SELECT id, subdomain, prefix FROM agencies WHERE subdomain = $1 LIMIT 1',
    [slug]
  );

  let agencyId;
  let prefix;

  if (existingAgencies.length > 0) {
    agencyId = existingAgencies[0].id;
    prefix = existingAgencies[0].prefix;
    console.error(`[seed-initial-tenant] Agency '${slug}' already exists (id=${agencyId}, prefix=${prefix}) — skipping create`);
  } else {
    // 2. Generate unique prefix
    const basePrefix = generatePrefix(agencyName);
    prefix = await ensureUniquePrefix(basePrefix);

    // 3. Create agency row
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 365); // Tier A — 1 year trial flag (real billing handled centrally)

    const { rows: agencyRows } = await pool.query(
      `INSERT INTO agencies (
         subdomain, name, name_bn, prefix, phone, email, address,
         id_counters, plan, status, settings, trial_ends_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         '{"student":0,"visitor":0,"payment":0,"invoice":0,"submission":0}'::jsonb,
         'dedicated', 'active', '{"dedicated":true}'::jsonb, $8
       )
       RETURNING id`,
      [slug, agencyName, agencyNameBn, prefix, phone, adminEmail, address, trialEndsAt.toISOString()]
    );
    agencyId = agencyRows[0].id;
    console.error(`[seed-initial-tenant] Created agency id=${agencyId} prefix=${prefix}`);
  }

  // 4. Idempotency — does the admin user already exist for this agency?
  const { rows: existingUsers } = await pool.query(
    'SELECT id, email FROM users WHERE agency_id = $1 AND email = $2 LIMIT 1',
    [agencyId, adminEmail]
  );

  let userId;

  if (existingUsers.length > 0) {
    userId = existingUsers[0].id;
    console.error(`[seed-initial-tenant] Admin user '${adminEmail}' already exists (id=${userId}) — skipping create`);
  } else {
    // 5. Hash + create owner user
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (
         agency_id, name, email, password_hash, role, branch, is_active, permissions
       ) VALUES (
         $1, $2, $3, $4, 'owner', 'Main', true, '{}'::jsonb
       )
       RETURNING id`,
      [agencyId, adminName, adminEmail, passwordHash]
    );
    userId = userRows[0].id;
    console.error(`[seed-initial-tenant] Created owner user id=${userId}`);
  }

  // 6. Print machine-readable summary on stdout
  const summary = {
    success: true,
    slug,
    agency_id: agencyId,
    agency_name: agencyName,
    prefix,
    user_id: userId,
    admin_email: adminEmail,
    frontend_url: `https://${slug}.agencybook.net`,
    api_url: `https://${slug}-api.agencybook.net`,
  };
  console.log(JSON.stringify(summary, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('[seed-initial-tenant] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
