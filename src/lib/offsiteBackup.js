/**
 * offsiteBackup.js — Daily DB + uploads dump → cloud storage
 *
 * SYSTEM-LEVEL backup (single shared DB across all agencies). Configured
 * by super_admin via platform_settings. Agency owners see status read-only.
 *
 * Targets supported (Phase 1): Google Drive (service account auth)
 * Phase 2: S3 / Cloudflare R2 (just add another upload function)
 *
 * USAGE
 * -----
 *   const { runBackup, getStatus, testConnection } = require("./offsiteBackup");
 *   await runBackup();             // pg_dump + tar uploads + upload + cleanup
 *
 * CONFIG (in platform_settings)
 * -----------------------------
 *   backup_target           : 'gdrive'
 *   backup_credentials      : encrypted JSON string of service account
 *   backup_drive_folder_id  : Google Drive folder ID where files land
 *   backup_retention_days   : INT, default 30
 *   backup_enabled          : BOOL
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");
const { google } = require("googleapis");

const supabase = require("./db");
const pool = supabase.pool;
const { encrypt, decrypt } = require("./crypto");
const { notify } = require("./notify");

// ────────────────────────────────────────────────────────────
// platform_settings helpers (key/JSONB store)
// ────────────────────────────────────────────────────────────
async function getPlatformSetting(key) {
  const { rows } = await pool.query(
    `SELECT value FROM platform_settings WHERE key = $1`, [key]
  );
  return rows.length ? rows[0].value : null;
}
async function setPlatformSetting(key, value) {
  await pool.query(`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()
  `, [key, JSON.stringify(value)]);
}

// ────────────────────────────────────────────────────────────
// pg_dump → temp gz file
// ────────────────────────────────────────────────────────────
async function makeDbDump(outputPath) {
  return new Promise((resolve, reject) => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return reject(new Error("DATABASE_URL not set"));

    // pg_dump -Fc (custom format) + gzip via piping
    const pgDump = spawn("pg_dump", [
      "--no-owner", "--no-acl",
      "--format=custom",
      "--file", outputPath,
      dbUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    pgDump.stderr.on("data", chunk => { stderr += chunk.toString(); });
    pgDump.on("error", reject);
    pgDump.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`pg_dump exit ${code}: ${stderr.slice(0, 500)}`));
      }
      resolve(outputPath);
    });
  });
}

// ────────────────────────────────────────────────────────────
// uploads/ folder → tar.gz
// ────────────────────────────────────────────────────────────
function makeUploadsArchive(outputPath) {
  return new Promise((resolve, reject) => {
    const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads");
    if (!fs.existsSync(uploadsDir)) return resolve(null); // nothing to archive

    const out = fs.createWriteStream(outputPath);
    const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });

    out.on("close", () => resolve(outputPath));
    archive.on("error", reject);
    archive.pipe(out);
    archive.directory(uploadsDir, "uploads");
    archive.finalize();
  });
}

// ────────────────────────────────────────────────────────────
// Google Drive client
// ────────────────────────────────────────────────────────────
function getDriveClient(serviceAccountJson) {
  const auth = new google.auth.JWT({
    email: serviceAccountJson.client_email,
    key: serviceAccountJson.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

async function uploadToDrive({ drive, filePath, folderId }) {
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: folderId ? [folderId] : undefined,
    },
    media: {
      mimeType: "application/gzip",
      body: fs.createReadStream(filePath),
    },
    fields: "id, name, size, createdTime",
  }, {
    // resumable upload for large files
    onUploadProgress: () => {},
  });
  return { id: res.data.id, name: res.data.name, size: fileSize };
}

async function listDriveFiles({ drive, folderId, prefix }) {
  const q = [
    folderId ? `'${folderId}' in parents` : null,
    prefix ? `name contains '${prefix}'` : null,
    `trashed = false`,
  ].filter(Boolean).join(" and ");
  const res = await drive.files.list({
    q, fields: "files(id, name, size, createdTime)",
    orderBy: "createdTime desc",
    pageSize: 100,
  });
  return res.data.files || [];
}

async function deleteDriveFile({ drive, fileId }) {
  await drive.files.delete({ fileId });
}

// ────────────────────────────────────────────────────────────
// Get config + creds, decrypted
// ────────────────────────────────────────────────────────────
async function loadConfig() {
  const config = await getPlatformSetting("backup_config") || {};
  if (config.credentials_encrypted) {
    try {
      const decrypted = decrypt(config.credentials_encrypted);
      config.credentials = JSON.parse(decrypted);
    } catch (err) {
      throw new Error(`Failed to decrypt backup credentials: ${err.message}`);
    }
  }
  return config;
}

// ────────────────────────────────────────────────────────────
// PUBLIC API
// ────────────────────────────────────────────────────────────

/**
 * Save backup configuration (super_admin).
 */
async function saveConfig({ target, credentials, folderId, retentionDays, enabled, scheduleCron }) {
  const existing = (await getPlatformSetting("backup_config")) || {};
  const next = {
    ...existing,
    target: target || existing.target || "gdrive",
    folder_id: folderId !== undefined ? folderId : existing.folder_id,
    retention_days: retentionDays !== undefined ? retentionDays : (existing.retention_days || 30),
    enabled: enabled !== undefined ? !!enabled : (existing.enabled || false),
    schedule_cron: scheduleCron || existing.schedule_cron || "0 2 * * *",
  };
  if (credentials !== undefined) {
    if (credentials === null) {
      next.credentials_encrypted = null;
    } else {
      const json = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
      next.credentials_encrypted = encrypt(json);
    }
  }
  await setPlatformSetting("backup_config", next);
  return getStatus();
}

/**
 * Read sanitized status (no secrets).
 */
async function getStatus() {
  const config = await getPlatformSetting("backup_config") || {};
  return {
    target: config.target || null,
    enabled: !!config.enabled,
    folder_id: config.folder_id || null,
    retention_days: config.retention_days || 30,
    schedule_cron: config.schedule_cron || "0 2 * * *",
    credentials_set: !!config.credentials_encrypted,
    last_success: config.last_success || null,
    last_error: config.last_error || null,
    last_error_at: config.last_error_at || null,
    last_filename: config.last_filename || null,
    last_size: config.last_size || null,
  };
}

/**
 * Test the connection without uploading.
 */
async function testConnection() {
  const cfg = await loadConfig();
  if (!cfg.credentials) throw new Error("Credentials not configured");
  if (cfg.target === "gdrive") {
    const drive = getDriveClient(cfg.credentials);
    // Probe by listing the target folder
    const files = await listDriveFiles({ drive, folderId: cfg.folder_id, prefix: "" });
    return { ok: true, target: "gdrive", folder_id: cfg.folder_id, files_in_folder: files.length };
  }
  throw new Error(`Unsupported target: ${cfg.target}`);
}

/**
 * Run a full backup: dump DB + archive uploads + upload + cleanup old.
 */
async function runBackup() {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { skipped: "not_enabled" };
  if (!cfg.credentials) throw new Error("Credentials not configured");

  const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agencybook-backup-"));
  const dbDumpPath = path.join(tmpDir, `db_${dateStr}.dump`);
  const uploadsArchivePath = path.join(tmpDir, `uploads_${dateStr}.tar.gz`);

  const stats = { startedAt: new Date().toISOString() };
  try {
    // 1. DB dump
    await makeDbDump(dbDumpPath);
    stats.db_size = fs.statSync(dbDumpPath).size;

    // 2. uploads archive (optional — may be empty)
    let archivedUploads = null;
    if (process.env.SKIP_UPLOADS_BACKUP !== "true") {
      try {
        archivedUploads = await makeUploadsArchive(uploadsArchivePath);
        if (archivedUploads) stats.uploads_size = fs.statSync(uploadsArchivePath).size;
      } catch (e) {
        console.warn("[backup] uploads archive failed:", e.message);
      }
    }

    // 3. Upload
    if (cfg.target === "gdrive") {
      const drive = getDriveClient(cfg.credentials);
      const dbResult = await uploadToDrive({ drive, filePath: dbDumpPath, folderId: cfg.folder_id });
      stats.db_remote = dbResult;
      if (archivedUploads) {
        const upResult = await uploadToDrive({ drive, filePath: uploadsArchivePath, folderId: cfg.folder_id });
        stats.uploads_remote = upResult;
      }

      // 4. Retention cleanup
      const cutoff = Date.now() - cfg.retention_days * 24 * 60 * 60 * 1000;
      const allFiles = await listDriveFiles({ drive, folderId: cfg.folder_id });
      let deleted = 0;
      for (const f of allFiles) {
        if (new Date(f.createdTime).getTime() < cutoff) {
          try {
            await deleteDriveFile({ drive, fileId: f.id });
            deleted++;
          } catch (e) {
            console.warn("[backup] retention delete failed:", f.name, e.message);
          }
        }
      }
      stats.deleted_old = deleted;
    } else {
      throw new Error(`Unsupported target: ${cfg.target}`);
    }

    stats.completedAt = new Date().toISOString();
    stats.success = true;

    // 5. Save success marker
    await setPlatformSetting("backup_config", {
      ...cfg,
      credentials_encrypted: cfg.credentials_encrypted, // preserve
      credentials: undefined,                            // strip
      last_success: stats.completedAt,
      last_filename: stats.db_remote?.name,
      last_size: stats.db_size + (stats.uploads_size || 0),
      last_error: null,
      last_error_at: null,
    });
  } catch (err) {
    stats.error = err.message;
    stats.success = false;
    await setPlatformSetting("backup_config", {
      ...cfg,
      credentials: undefined,
      last_error: err.message,
      last_error_at: new Date().toISOString(),
    });

    // Notify super_admin owners — find users with role='super_admin' or 'owner'
    try {
      const { rows: admins } = await pool.query(
        `SELECT u.id, u.email, u.agency_id FROM users u WHERE u.role IN ('super_admin','owner') AND u.email IS NOT NULL`
      );
      // Group by agency, send email if any
      const byAgency = {};
      for (const u of admins) {
        if (!byAgency[u.agency_id]) byAgency[u.agency_id] = [];
        byAgency[u.agency_id].push({ email: u.email });
      }
      for (const [agencyId, recipients] of Object.entries(byAgency)) {
        await notify({
          agencyId, channel: "email", to: recipients,
          template: "backup_failed",
          data: { error: err.message, lastSuccess: cfg.last_success || "never" },
        });
      }
    } catch (e) {
      console.error("[backup] failed to send failure notification:", e.message);
    }

    throw err;
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.warn("[backup] tmp cleanup failed:", e.message);
    }
  }
  return stats;
}

/**
 * List remote backup files.
 */
async function listBackups() {
  const cfg = await loadConfig();
  if (!cfg.credentials) throw new Error("Credentials not configured");
  if (cfg.target === "gdrive") {
    const drive = getDriveClient(cfg.credentials);
    return listDriveFiles({ drive, folderId: cfg.folder_id });
  }
  throw new Error(`Unsupported target: ${cfg.target}`);
}

module.exports = {
  saveConfig,
  getStatus,
  testConnection,
  runBackup,
  listBackups,
  loadConfig,    // exposed for scheduler
};
