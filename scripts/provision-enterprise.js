#!/usr/bin/env node
/**
 * scripts/provision-enterprise.js
 *
 * One-time bootstrap for an Enterprise customer's dedicated VPS install.
 * Creates an agency + owner user + prints the credentials. After this,
 * the owner logs in, goes to Settings → Integrations, and configures
 * their own AI/SMTP/R2 keys (no platform fallback in INSTANCE_MODE=enterprise).
 *
 * Prereqs (set BEFORE running):
 *   - /home/<customer>/backend/.env exists with:
 *       INSTANCE_MODE=enterprise
 *       DATABASE_URL=postgres://...
 *       JWT_SECRET=<generated>
 *       ENCRYPTION_KEY=<generated 64-hex>
 *       UPLOADS_DIR=/home/<customer>/uploads
 *       STORAGE_BACKEND=local         # or mirror if R2 already wired
 *   - DB schema applied (psql -f deploy/schema.sql)
 *   - All BYOK migrations applied (deploy/migration_*.sql)
 *
 * Usage:
 *   cd /home/<customer>/backend
 *   node scripts/provision-enterprise.js \
 *       --agency-name "Acme Study Abroad" \
 *       --agency-name-bn "অ্যাকমে স্টাডি অ্যাব্রোড" \
 *       --subdomain acme \
 *       --owner-name "Owner Name" \
 *       --owner-email owner@acme.com \
 *       --owner-password "<initial password — owner changes on first login>"
 *
 * Output: prints the agency_id, user_id, and login credentials. Save these
 * and securely deliver to the customer.
 *
 * Idempotent: re-running with the same email upserts the user, doesn't
 * create duplicates.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const required = ["agency-name", "subdomain", "owner-name", "owner-email"];
const missing = required.filter(k => !args[k]);
if (missing.length) {
  console.error("Missing required args:", missing.join(", "));
  console.error("\nUsage:");
  console.error("  node scripts/provision-enterprise.js --agency-name '...' --subdomain ... --owner-name '...' --owner-email ... [--agency-name-bn '...'] [--owner-password '...'] [--prefix XXX]");
  process.exit(1);
}

const agencyName = args["agency-name"];
const agencyNameBn = args["agency-name-bn"] || agencyName;
const subdomain = String(args["subdomain"]).toLowerCase().replace(/[^a-z0-9-]/g, "");
const ownerName = args["owner-name"];
const ownerEmail = String(args["owner-email"]).toLowerCase().trim();
// If no password given, generate a secure random one (16 hex = 64 bits, ASCII-safe)
const ownerPassword = args["owner-password"] || crypto.randomBytes(8).toString("hex");
const generatedPassword = !args["owner-password"];
const prefix = (args["prefix"] || subdomain.slice(0, 3).toUpperCase()).slice(0, 5);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}
if (process.env.INSTANCE_MODE !== "enterprise") {
  console.warn("[provision] WARNING: INSTANCE_MODE=" + (process.env.INSTANCE_MODE || "<unset>") + " — this script is intended for enterprise installs.");
  console.warn("[provision]          Continuing anyway. To suppress, set INSTANCE_MODE=enterprise in .env.\n");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  console.log(`[provision] target DB: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@")}`);
  console.log(`[provision] creating agency "${agencyName}" (subdomain=${subdomain}, prefix=${prefix})`);

  // 1. Upsert agency. Use deterministic UUID from subdomain so re-runs are
  //    idempotent — customer gets the same agency_id every time.
  const agencyId = crypto.createHash("md5").update("agency:" + subdomain).digest("hex").replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12}).*/,
    "$1-$2-$3-$4-$5"
  );

  const { rows: agencyRows } = await pool.query(
    `INSERT INTO agencies (id, subdomain, name, name_bn, prefix, plan, status)
     VALUES ($1, $2, $3, $4, $5, 'enterprise', 'active')
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, name_bn = EXCLUDED.name_bn, prefix = EXCLUDED.prefix,
       plan = EXCLUDED.plan, status = EXCLUDED.status, updated_at = now()
     RETURNING id, subdomain, name, prefix, plan`,
    [agencyId, subdomain, agencyName, agencyNameBn, prefix]
  );
  console.log(`[provision] agency: ${JSON.stringify(agencyRows[0])}`);

  // 2. Upsert owner user
  const passwordHash = await bcrypt.hash(ownerPassword, 10);
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (agency_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'owner')
     ON CONFLICT (agency_id, email) DO UPDATE SET
       name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, role = 'owner', updated_at = now()
     RETURNING id, email, role`,
    [agencyId, ownerName, ownerEmail, passwordHash]
  );
  console.log(`[provision] owner user: ${JSON.stringify(userRows[0])}`);

  console.log("\n========================================");
  console.log("  Enterprise Provisioning Complete");
  console.log("========================================");
  console.log(`  Agency:    ${agencyName}`);
  console.log(`  Subdomain: ${subdomain}`);
  console.log(`  Login:     ${ownerEmail}`);
  console.log(`  Password:  ${ownerPassword}${generatedPassword ? "  (auto-generated; owner should change on first login)" : ""}`);
  console.log("========================================");
  console.log("\nNext steps:");
  console.log("  1. Securely deliver the credentials above to the customer.");
  console.log("  2. Customer logs in → forced through onboarding flow.");
  console.log("  3. Customer enters their Anthropic / R2 / SMTP keys in");
  console.log("     Settings → Integrations.");
  console.log("  4. Once integrations are configured, AI / OCR / email features");
  console.log("     activate. Until then, those features will show 'Configure");
  console.log("     in Settings → Integrations' messages.");
  console.log("\n  See deploy/ENTERPRISE.md for the full operator runbook.");

  await pool.end();
  process.exit(0);
})().catch(err => {
  console.error("[provision] FAILED:", err);
  pool.end();
  process.exit(2);
});
