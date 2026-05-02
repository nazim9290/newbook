#!/usr/bin/env node
/**
 * scripts/storage-reconcile.js
 *
 * Detects and (optionally) repairs drift between local FS and R2 in
 * `mirror` mode. Run on-demand or via cron (recommended: nightly).
 *
 * What it does:
 *   1. Lists every object in R2 bucket
 *   2. Walks every file under UPLOADS_DIR/{excel-templates,doc-templates,interview-templates}
 *   3. Compares the two sets and reports:
 *        - LOCAL_ONLY  → files on disk but not in R2 (mirror lag)
 *        - R2_ONLY     → files in R2 but not on disk (e.g. local disk wiped, candidate for restore)
 *        - SIZE_DIFF   → filename matches but byte size differs (rare; corruption flag)
 *   4. Cross-checks DB rows: any template_url in DB that has no file in
 *      either store is flagged ORPHAN (can't be generated).
 *
 * Modes:
 *   --report    (default)  Just print findings, change nothing
 *   --fix-r2               Push LOCAL_ONLY files to R2
 *   --fix-local            Pull R2_ONLY files down to local FS
 *   --fix-all              Both directions
 *
 * Exit codes:
 *   0 = clean (no drift)
 *   1 = drift detected (in --report mode)
 *   2 = repair failures
 *
 * Usage:
 *   node scripts/storage-reconcile.js                    # report only
 *   node scripts/storage-reconcile.js --fix-r2           # heal R2 from local
 *   node scripts/storage-reconcile.js --fix-all          # heal both directions
 *
 *   # Cron (root crontab on VPS):
 *   #   0 3 * * *  cd /home/agencybook/backend && node scripts/storage-reconcile.js >> /home/agencybook/logs/storage-reconcile.log 2>&1
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const fixR2 = args.includes("--fix-r2") || args.includes("--fix-all");
const fixLocal = args.includes("--fix-local") || args.includes("--fix-all");
const REPORT_ONLY = !fixR2 && !fixLocal;

if (!process.env.R2_ACCOUNT_ID) {
  console.error("[reconcile] R2 credentials missing in .env — set R2_ACCOUNT_ID etc.");
  process.exit(2);
}

const local = require("../src/lib/storage/local");
const r2 = require("../src/lib/storage/r2");
const supabase = require("../src/lib/db");
const { decrypt } = require("../src/lib/crypto");

const SUBDIRS = ["excel-templates", "doc-templates", "interview-templates"];

// List objects in a single R2 bucket using either the platform credentials
// (no creds arg) or an agency's BYOK credentials. Returns Map<key, size>.
async function listBucket(creds) {
  const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const accountId = creds?.account_id || process.env.R2_ACCOUNT_ID;
  const accessKey = creds?.access_key_id || process.env.R2_ACCESS_KEY_ID;
  const secret = creds?.secret_access_key || process.env.R2_SECRET_ACCESS_KEY;
  const bucket = creds?.bucket || process.env.R2_BUCKET || "agencybook-uploads";
  if (!accountId || !accessKey || !secret) return new Map();

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });

  const all = new Map();
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents || []) all.set(obj.Key, obj.Size);
    token = res.NextContinuationToken;
  } while (token);
  return all;
}

async function listR2Objects() {
  return listBucket(null); // platform bucket
}

// Discover all agencies that have BYOK r2 — returns array of {agencyId, creds}
// Used to also reconcile agency-owned buckets so drift is caught everywhere.
async function listAgencyR2Configs() {
  const { rows } = await supabase.pool.query(
    `SELECT i.agency_id, i.credentials, a.name AS agency_name
     FROM agency_integrations i
     JOIN agencies a ON a.id = i.agency_id
     WHERE i.service = 'r2' AND i.enabled = true`
  );
  const configs = [];
  for (const r of rows) {
    try {
      const c = r.credentials || {};
      configs.push({
        agencyId: r.agency_id,
        agencyName: r.agency_name,
        creds: {
          account_id: c.account_id,
          access_key_id: decrypt(c.access_key_id),
          secret_access_key: decrypt(c.secret_access_key),
          bucket: c.bucket,
        },
      });
    } catch (e) {
      console.warn(`[reconcile] decrypt failed for agency=${r.agency_id}:`, e.message);
    }
  }
  return configs;
}

function listLocalFiles() {
  const all = new Map(); // relative key → size
  for (const sub of SUBDIRS) {
    const dir = path.join(local.UPLOADS_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) all.set(`${sub}/${f}`, st.size);
      } catch {}
    }
  }
  return all;
}

async function listDbReferencedKeys() {
  const keys = new Set();
  try {
    const r = await supabase.pool.query(`SELECT template_url FROM excel_templates WHERE template_url IS NOT NULL`);
    for (const row of r.rows) keys.add(row.template_url);
  } catch (e) { console.warn("[reconcile] excel_templates query failed:", e.message); }
  try {
    const r = await supabase.pool.query(`SELECT template_url FROM doc_templates WHERE template_url IS NOT NULL`);
    for (const row of r.rows) keys.add(row.template_url);
  } catch (e) { console.warn("[reconcile] doc_templates query failed:", e.message); }
  return keys;
}

(async () => {
  console.log(`[reconcile] mode = ${REPORT_ONLY ? "report" : (fixR2 && fixLocal ? "fix-all" : fixR2 ? "fix-r2" : "fix-local")}`);
  console.log(`[reconcile] UPLOADS_DIR = ${local.UPLOADS_DIR}`);
  console.log(`[reconcile] R2 bucket   = ${process.env.R2_BUCKET || "agencybook-uploads"}`);

  const [r2Map, localMap, dbKeys] = await Promise.all([
    listR2Objects(),
    Promise.resolve(listLocalFiles()),
    listDbReferencedKeys(),
  ]);

  console.log(`[reconcile] R2 objects: ${r2Map.size}, local files: ${localMap.size}, DB-referenced keys: ${dbKeys.size}`);

  // Categorize
  const localOnly = [];
  const r2Only = [];
  const sizeDiff = [];
  const orphanDb = [];

  for (const [key, size] of localMap) {
    if (!r2Map.has(key)) localOnly.push({ key, size });
    else if (r2Map.get(key) !== size) sizeDiff.push({ key, localSize: size, r2Size: r2Map.get(key) });
  }
  for (const [key, size] of r2Map) {
    if (!localMap.has(key)) r2Only.push({ key, size });
  }
  for (const key of dbKeys) {
    if (!localMap.has(key) && !r2Map.has(key)) orphanDb.push(key);
  }

  // Report
  console.log("\n=== DRIFT REPORT ===");
  console.log(`LOCAL_ONLY (${localOnly.length}) — on disk, missing in R2`);
  for (const x of localOnly.slice(0, 20)) console.log(`  ${x.key} (${x.size}b)`);
  if (localOnly.length > 20) console.log(`  ... and ${localOnly.length - 20} more`);

  console.log(`\nR2_ONLY (${r2Only.length}) — in R2, missing on disk`);
  for (const x of r2Only.slice(0, 20)) console.log(`  ${x.key} (${x.size}b)`);
  if (r2Only.length > 20) console.log(`  ... and ${r2Only.length - 20} more`);

  console.log(`\nSIZE_DIFF (${sizeDiff.length}) — same name, different size (rare; corruption indicator)`);
  for (const x of sizeDiff) console.log(`  ${x.key}  local=${x.localSize}b  r2=${x.r2Size}b`);

  console.log(`\nORPHAN_DB (${orphanDb.length}) — DB row points to a file present in NEITHER store`);
  for (const k of orphanDb.slice(0, 10)) console.log(`  ${k}`);
  if (orphanDb.length > 10) console.log(`  ... and ${orphanDb.length - 10} more`);

  // Agency-BYOK buckets — separate reconciliation pass per agency
  const agencyConfigs = await listAgencyR2Configs();
  if (agencyConfigs.length > 0) {
    console.log(`\n=== AGENCY BYOK R2 BUCKETS (${agencyConfigs.length}) ===`);
    for (const cfg of agencyConfigs) {
      try {
        const agencyR2Map = await listBucket(cfg.creds);
        // Files this agency owns locally — match by filename containing agency_id
        const agencyLocalKeys = new Set();
        for (const [key, size] of localMap) {
          if (key.includes(cfg.agencyId)) agencyLocalKeys.add(key);
        }
        const agencyMissingInR2 = [];
        for (const key of agencyLocalKeys) {
          if (!agencyR2Map.has(key)) agencyMissingInR2.push(key);
        }
        console.log(`  ${cfg.agencyName} (${cfg.agencyId.slice(0, 8)}...): bucket="${cfg.creds.bucket}" objects=${agencyR2Map.size}, local-files-owned-by-agency=${agencyLocalKeys.size}, missing-in-byok-r2=${agencyMissingInR2.length}`);
        if (agencyMissingInR2.length > 0 && agencyMissingInR2.length <= 5) {
          for (const k of agencyMissingInR2) console.log(`    [drift] ${k}`);
        }
      } catch (e) {
        console.error(`  [error] ${cfg.agencyName} (${cfg.agencyId.slice(0, 8)}...): ${e.message}`);
      }
    }
    console.log("\n  Note: agency BYOK buckets are not auto-fixed by this script. The");
    console.log("  agency owns those buckets — they should configure their own backup.");
    console.log("  If you see drift, contact the agency owner and have them check.");
  }

  // Repair
  let repairFails = 0;
  if (fixR2 && localOnly.length) {
    console.log(`\n[reconcile] pushing ${localOnly.length} files local → R2 ...`);
    for (const x of localOnly) {
      try {
        const buf = fs.readFileSync(path.join(local.UPLOADS_DIR, x.key));
        await r2.put(x.key, buf);
        console.log(`  [r2 put] ${x.key}`);
      } catch (e) { console.error(`  [r2 put FAIL] ${x.key}: ${e.message}`); repairFails++; }
    }
  }
  if (fixLocal && r2Only.length) {
    console.log(`\n[reconcile] pulling ${r2Only.length} files R2 → local ...`);
    for (const x of r2Only) {
      try {
        const buf = await r2.get(x.key);
        if (!buf) { console.warn(`  [skip] ${x.key} — R2 returned empty`); continue; }
        await local.put(x.key, buf);
        console.log(`  [local put] ${x.key}`);
      } catch (e) { console.error(`  [local put FAIL] ${x.key}: ${e.message}`); repairFails++; }
    }
  }

  const driftCount = localOnly.length + r2Only.length + sizeDiff.length + orphanDb.length;
  if (REPORT_ONLY) {
    if (driftCount === 0) console.log("\n[reconcile] CLEAN — no drift, no orphan DB rows");
    process.exit(driftCount === 0 ? 0 : 1);
  } else {
    if (repairFails > 0) console.log(`\n[reconcile] DONE with ${repairFails} repair failure(s)`);
    else console.log("\n[reconcile] DONE — drift repaired");
    process.exit(repairFails > 0 ? 2 : 0);
  }
})().catch(err => {
  console.error("[reconcile] FATAL:", err);
  process.exit(2);
});
