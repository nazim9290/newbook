#!/usr/bin/env node
/**
 * scripts/migrate-uploads-to-r2.js
 *
 * One-time migration: walk every file in UPLOADS_DIR (or its standard
 * subdirs), upload each to Cloudflare R2 under the same relative key,
 * and rewrite excel_templates.template_url + doc_templates.template_url +
 * doc_templates.file_path in the DB to use the relative key.
 *
 * SAFETY:
 *   - Idempotent — re-running skips files already present in R2.
 *   - Never deletes from local FS. After verifying R2 contents, you can
 *     manually `rm -rf` the old local uploads dir.
 *   - DB rewrite only converts absolute paths → relative keys (basename
 *     stays the same). It does NOT change relative keys that are already
 *     correct.
 *
 * USAGE:
 *   1. Set R2 credentials in backend/.env:
 *        R2_ACCOUNT_ID=...
 *        R2_ACCESS_KEY_ID=...
 *        R2_SECRET_ACCESS_KEY=...
 *        R2_BUCKET=agencybook-uploads
 *      (Leave STORAGE_BACKEND=local for now — switch AFTER migration verifies.)
 *
 *   2. Run:
 *        cd /home/agencybook/backend
 *        node scripts/migrate-uploads-to-r2.js
 *
 *   3. Verify R2 has the files (Cloudflare dashboard or `aws s3 ls`).
 *
 *   4. Flip STORAGE_BACKEND=r2 in .env and pm2 restart agencybook-api.
 *
 *   5. Test: download a template from the app. If it works, delete the
 *      old local uploads/ folder.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");

if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error("[migrate] R2 credentials missing — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env");
  process.exit(1);
}

const r2 = require("../src/lib/storage/r2");
const supabase = require("../src/lib/db");

const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve(__dirname, "../uploads");

const SUBDIRS = ["excel-templates", "doc-templates", "interview-templates"];

async function uploadDirToR2(subdir) {
  const dir = path.join(UPLOADS_DIR, subdir);
  if (!fs.existsSync(dir)) return { uploaded: 0, skipped: 0 };

  let uploaded = 0, skipped = 0;
  const files = fs.readdirSync(dir);
  for (const fname of files) {
    const full = path.join(dir, fname);
    if (!fs.statSync(full).isFile()) continue;

    const key = `${subdir}/${fname}`;

    if (await r2.exists(key)) { skipped++; continue; }

    const buf = fs.readFileSync(full);
    await r2.put(key, buf);
    console.log(`[r2] put ${key} (${buf.length} bytes)`);
    uploaded++;
  }
  return { uploaded, skipped };
}

async function rekeyExcelTemplates() {
  // excel_templates.template_url: absolute path → "excel-templates/<basename>"
  const { rows } = await supabase.pool.query(
    `SELECT id, template_url FROM excel_templates WHERE template_url LIKE '/%'`
  );
  for (const r of rows) {
    const newKey = `excel-templates/${path.basename(r.template_url)}`;
    await supabase.pool.query(
      `UPDATE excel_templates SET template_url = $1 WHERE id = $2`,
      [newKey, r.id]
    );
    console.log(`[db] excel_templates ${r.id}: ${r.template_url} → ${newKey}`);
  }
  return rows.length;
}

async function rekeyDocTemplates() {
  const { rows } = await supabase.pool.query(
    `SELECT id, template_url, file_path FROM doc_templates WHERE template_url LIKE '/%' OR file_path LIKE '/%'`
  );
  for (const r of rows) {
    const newKey = `doc-templates/${path.basename(r.template_url || r.file_path)}`;
    await supabase.pool.query(
      `UPDATE doc_templates SET template_url = $1, file_path = $1 WHERE id = $2`,
      [newKey, r.id]
    );
    console.log(`[db] doc_templates ${r.id}: ${r.template_url} → ${newKey}`);
  }
  return rows.length;
}

(async () => {
  console.log("[migrate] starting — UPLOADS_DIR =", UPLOADS_DIR);
  console.log("[migrate] R2 bucket =", process.env.R2_BUCKET || "agencybook-uploads");

  // 1. Upload files to R2
  for (const sub of SUBDIRS) {
    const { uploaded, skipped } = await uploadDirToR2(sub);
    console.log(`[migrate] ${sub}: uploaded=${uploaded}, skipped(already-in-R2)=${skipped}`);
  }

  // 2. Re-key DB rows: absolute paths → relative keys
  const excelCount = await rekeyExcelTemplates();
  const docCount = await rekeyDocTemplates();
  console.log(`[migrate] DB rekey: excel_templates=${excelCount} rows, doc_templates=${docCount} rows`);

  console.log("\n[migrate] DONE. Next steps:");
  console.log("  1. Verify in Cloudflare R2 dashboard that files are present.");
  console.log("  2. Set STORAGE_BACKEND=r2 in /home/agencybook/backend/.env");
  console.log("  3. su - agencybook -c 'pm2 restart agencybook-api --update-env'");
  console.log("  4. Test a generate/download in the app. If broken, set STORAGE_BACKEND=local and retry.");

  process.exit(0);
})().catch(err => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
