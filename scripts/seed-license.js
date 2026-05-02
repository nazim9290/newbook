#!/usr/bin/env node
/**
 * seed-license.js — Phase 0 helper: create / update an instance + license row.
 *
 * Usage examples:
 *
 *   # Seed the central demo instance (max 999 agencies, all features)
 *   node scripts/seed-license.js --instance demo --tier central
 *
 *   # Seed a Tier A (Dedicated cloud) instance (single-tenant, normal features)
 *   node scripts/seed-license.js --instance abc-agency --tier dedicated --hostname abc.agencybook.net
 *
 *   # Seed a Tier B (Customer VPS) — same as dedicated for now
 *   node scripts/seed-license.js --instance xyz-agency --tier customer-vps --hostname agency.xyz.com
 *
 *   # Upgrade an existing license to allow more agencies
 *   node scripts/seed-license.js --instance abc-agency --max-agencies 5
 *
 * Idempotent: re-running with same instance updates the license row in place.
 *
 * Reads DATABASE_URL from .env (same as backend).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabase = require('../src/lib/db');

const TIERS = {
  central: {
    deployment_mode: 'shared-saas',
    max_agencies: 999,
    features: {
      super_admin_panel: true,
      agency_switcher_ui: true,
      multi_branch: true,
      ai_translation: true,
      ai_ocr: true,
      smart_matching: true,
      central_proxy: false,
    },
    notes: 'Owner-operated central SaaS — full features, unlimited tenants',
  },
  dedicated: {
    deployment_mode: 'dedicated',
    max_agencies: 1,
    features: {
      super_admin_panel: false,
      agency_switcher_ui: false,
      multi_branch: true,
      ai_translation: true,
      ai_ocr: true,
      smart_matching: true,
      central_proxy: false,
    },
    notes: 'Tier A — Dedicated cloud instance, single tenant',
  },
  'customer-vps': {
    deployment_mode: 'customer-vps',
    max_agencies: 1,
    features: {
      super_admin_panel: false,
      agency_switcher_ui: false,
      multi_branch: true,
      ai_translation: true,
      ai_ocr: true,
      smart_matching: true,
      central_proxy: false,
    },
    notes: 'Tier B — Customer-owned VPS, operator-managed, single tenant',
  },
  'on-premise': {
    deployment_mode: 'on-premise',
    max_agencies: 1,
    features: {
      super_admin_panel: false,
      agency_switcher_ui: false,
      multi_branch: true,
      ai_translation: true,
      ai_ocr: true,
      smart_matching: true,
      central_proxy: true, // on-prem MUST proxy AI calls (Phase 14)
    },
    notes: 'Tier C — True on-premise, customer-controlled hardware',
  },
};

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
  const instance = args.instance;
  const tier = args.tier;
  const hostname = args.hostname || null;
  const maxAgenciesOverride = args['max-agencies'] ? parseInt(args['max-agencies'], 10) : null;
  const channel = args.channel || 'stable';
  const description = args.description || null;

  if (!instance) {
    console.error('ERROR: --instance is required');
    console.error('Usage: node scripts/seed-license.js --instance <slug> --tier <central|dedicated|customer-vps|on-premise>');
    process.exit(1);
  }

  const pool = supabase.pool;

  // Existing license — fetch current to support upgrade-only mode (no --tier)
  let preset = tier ? TIERS[tier] : null;
  if (tier && !preset) {
    console.error(`ERROR: unknown tier '${tier}'. Valid: ${Object.keys(TIERS).join(', ')}`);
    process.exit(1);
  }

  // Upsert instance row
  await pool.query(
    `INSERT INTO instances (instance_id, deployment_mode, hostname, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (instance_id) DO UPDATE SET
       deployment_mode = COALESCE($2, instances.deployment_mode),
       hostname        = COALESCE($3, instances.hostname),
       description     = COALESCE($4, instances.description),
       updated_at      = now()`,
    [instance, preset?.deployment_mode || null, hostname, description]
  );

  // Existing active license — upgrade in place if found, else insert new
  const { rows: existing } = await pool.query(
    'SELECT id, max_agencies, features FROM licenses WHERE instance_id = $1 ORDER BY issued_at DESC LIMIT 1',
    [instance]
  );

  if (existing.length > 0 && !preset && !maxAgenciesOverride) {
    console.log(`License for '${instance}' already exists. Use --tier or --max-agencies to update.`);
    console.log('Current:', existing[0]);
    process.exit(0);
  }

  const finalMax = maxAgenciesOverride ?? preset?.max_agencies ?? existing[0]?.max_agencies ?? 1;
  const finalFeatures = preset?.features ?? existing[0]?.features ?? {};
  const finalNotes = preset?.notes ?? null;

  if (existing.length > 0) {
    // Update in place
    await pool.query(
      `UPDATE licenses SET max_agencies = $1, features = $2, update_channel = $3,
                          notes = COALESCE($4, notes), updated_at = now()
       WHERE id = $5`,
      [finalMax, JSON.stringify(finalFeatures), channel, finalNotes, existing[0].id]
    );
    console.log(`✓ Updated license for instance '${instance}'`);
  } else {
    await pool.query(
      `INSERT INTO licenses (instance_id, max_agencies, features, update_channel, status, notes)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [instance, finalMax, JSON.stringify(finalFeatures), channel, finalNotes]
    );
    console.log(`✓ Created license for instance '${instance}'`);
  }

  console.log(`  Instance:        ${instance}`);
  console.log(`  Deployment mode: ${preset?.deployment_mode || '(unchanged)'}`);
  console.log(`  Max agencies:    ${finalMax}`);
  console.log(`  Update channel:  ${channel}`);
  console.log(`  Features:        ${Object.keys(finalFeatures).filter(k => finalFeatures[k]).join(', ') || '(none)'}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
