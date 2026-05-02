# Storage backend — local FS or Cloudflare R2

The backend writes uploaded templates (Excel, .docx) and other files
through `lib/storage/index.js` — a thin facade that picks one of two
backends based on `STORAGE_BACKEND` in `.env`.

## Default: local filesystem

**`.env`**
```
STORAGE_BACKEND=local
UPLOADS_DIR=/home/agencybook/uploads
```

- All files live under `UPLOADS_DIR/<subdir>/<filename>`.
- DB columns store *relative* keys like `excel-templates/<file>` (not
  absolute paths — survives directory moves and PM2 cwd changes).
- `lib/storage/local.js` has 3 fallback layers for old DB rows that
  still hold absolute paths or basenames-only — those keep working
  silently while the next upload of each template upgrades the row.
- On boot, `app.js` calls `storage.ensureDirs()` which `mkdir -p`s the
  standard subfolders if missing — so a wiped `uploads/` self-heals.

The folder is intentionally *outside* the git-checked-out backend
directory so `git pull` and PM2 restarts cannot touch it.

## Optional: Cloudflare R2

When you outgrow local storage (multi-region, disk failure protection,
etc.), flip to R2. R2 is S3-compatible, free up to 10 GB, no egress
fees on Cloudflare network.

### Step 1 — Cloudflare R2 bucket

1. Log into Cloudflare dashboard → **R2 Object Storage** → Create
   bucket. Recommended name: `agencybook-uploads`.
2. Click the bucket → **Settings** → **CORS Policy** (only needed if
   you ever want browsers to fetch directly; for backend-only access,
   skip).
3. **Manage R2 API Tokens** → Create API Token:
   - Permissions: **Object Read & Write**
   - Specify bucket: `agencybook-uploads`
   - Save the **Access Key ID** and **Secret Access Key** — Cloudflare
     only shows the secret once.
4. Note the **Account ID** from the R2 dashboard URL or the token page.

### Step 2 — install AWS SDK on VPS

```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16
cd /home/agencybook/backend
npm install --legacy-peer-deps @aws-sdk/client-s3
```

(Backend works without this package as long as `STORAGE_BACKEND=local`.
It is required only when you flip the env var.)

### Step 3 — add credentials to `.env`

```
# Storage backend
STORAGE_BACKEND=local            # leave on local until migration verified
UPLOADS_DIR=/home/agencybook/uploads

# R2 credentials — used by lib/storage/r2.js when STORAGE_BACKEND=r2
R2_ACCOUNT_ID=<from cloudflare>
R2_ACCESS_KEY_ID=<from token>
R2_SECRET_ACCESS_KEY=<from token>
R2_BUCKET=agencybook-uploads
```

### Step 4 — migrate existing files

```bash
cd /home/agencybook/backend
node scripts/migrate-uploads-to-r2.js
```

The script:
- Walks `UPLOADS_DIR/{excel-templates,doc-templates,interview-templates}/`
- Uploads every file to R2 under the same relative key.
- Idempotent — files already present in R2 are skipped, so it's safe to
  re-run if interrupted.
- Rewrites any DB rows whose `template_url` still has an absolute path
  to use the relative key (basename stays).

Verify in Cloudflare dashboard that the files appear in the bucket.

### Step 5 — flip the backend

In `.env`:
```
STORAGE_BACKEND=r2
```

Restart PM2 to pick up the env:
```bash
su - agencybook -c "pm2 restart agencybook-api --update-env"
```

Tail the logs and check the boot line:
```
[storage] backend = r2 (bucket=agencybook-uploads)
```

### Step 6 — smoke test

In the app:
- Excel AutoFill → Generate → confirm `.xlsx` downloads with formatting
- Certificates → Generate → confirm `.docx` downloads

If anything breaks, immediately revert `STORAGE_BACKEND=local` and
restart PM2 — local files were never deleted, so this is a zero-downtime
rollback.

### Step 7 — clean up local copies (only after verification)

After ~1 week of stable R2 operation:
```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16
rm -rf /home/agencybook/uploads.archived-$(date +%F)   # if you renamed it
# or simply leave it — it's not consulted while STORAGE_BACKEND=r2
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `[storage] backend = local (UPLOADS_DIR=...)` shows wrong path on boot | `.env` not loaded before storage init | Verify `dotenv.config()` runs before `require("./lib/storage")` in `app.js` |
| `Template file পাওয়া যায়নি` on download | Old DB row points to a path that no longer exists in either local FS or R2 | Re-upload the template; new uploads use clean relative keys |
| `R2 credentials missing` on PM2 restart | `STORAGE_BACKEND=r2` set but credentials forgotten | Add `R2_*` vars to `.env`, restart with `--update-env` |
| `[storage/local] basename fallback used` warning in logs | Old absolute-path DB row matched via basename | Cosmetic — works fine. Re-upload the template to get a clean relative key. |
