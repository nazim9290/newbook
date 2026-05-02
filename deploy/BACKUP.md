# Backup & Disaster Recovery — AgencyBook Backend

End-to-end runbook for backing up production data and restoring from scratch. Read fully before running anything destructive.

## What gets backed up

| Asset | Location on VPS | Backup method |
|---|---|---|
| Postgres database | `agencybook_db` on local PG (port 5432) | `pg_dump` → gzip |
| Uploaded files (CVs, passports, school docs, photos) | `/home/agencybook/uploads/` | `tar -czf` |
| Per-agency BYOK secrets | inside `agency_integrations` table → caught by DB backup | (covered) |
| App code | `/home/agencybook/app/agency-os-backend/` | Not backed up — recoverable from git |
| `.env` | `/home/agencybook/app/agency-os-backend/.env` | **NOT backed up** — must be re-created from `1Password` / secrets vault on restore |

## Schedule (production)

| Job | Cadence | Cron line |
|---|---|---|
| Full DB + uploads backup | Daily 02:00 server time | `0 2 * * * /home/agencybook/backup_with_files.sh >> /home/agencybook/backups/backup.log 2>&1` |
| Cleanup (delete >7 days) | Daily, inside the backup script | (built in: `find … -mtime +7 -delete`) |
| Off-site sync (recommended) | Daily 03:00 | `0 3 * * * rclone copy /home/agencybook/backups/ remote:agencybook-backups/ --include "*.gz" --max-age 36h` |
| Backup-restore drill | Quarterly (1st Monday of Jan/Apr/Jul/Oct) | Manual — section "Restore drill" below |

## Retention

- **Local on VPS:** 7 days rolling (script enforces). Disk impact ~3-5 GB depending on DB+uploads.
- **Off-site (rclone target — Backblaze B2 / R2 / S3):** 90 days for daily, plus 12 monthly snapshots (manual rotation: copy the 1st-of-month dump into a `monthly/` folder before the 7-day cleanup wipes it).
- **Compliance:** matches Bangladesh DPA draft + agencies' typical "7-year tax record" expectation when monthly/yearly snapshots are kept off-site.

## How to restore — full system from scratch

This is the procedure for a complete VPS rebuild (new server, lost server, ransomware). Time budget: 60-90 minutes.

### 0. Pre-flight
- [ ] New VPS provisioned with Ubuntu 22.04+
- [ ] Backup file `db_YYYY-MM-DD_HHMM.sql.gz` accessible (from off-site or salvaged)
- [ ] Backup file `files_YYYY-MM-DD_HHMM.tar.gz` accessible
- [ ] `.env` content recoverable (from secrets vault — NOT from backup)
- [ ] DNS still pointing to old IP — leave it until step 8

### 1. Base setup
```bash
# As root on the new VPS:
apt update && apt upgrade -y
apt install -y postgresql nginx nodejs npm git curl
npm install -g pm2

# Create the agencybook user
adduser --disabled-password --gecos "" agencybook
mkdir -p /home/agencybook/app /home/agencybook/uploads /home/agencybook/backups
chown -R agencybook:agencybook /home/agencybook
```

### 2. Restore the database
```bash
# As root or postgres user:
sudo -u postgres psql -c "CREATE USER agencybook WITH PASSWORD '<password-from-vault>';"
sudo -u postgres psql -c "CREATE DATABASE agencybook_db OWNER agencybook;"

# Copy the backup dump to the VPS, then:
gunzip < db_2026-05-02_0200.sql.gz | sudo -u postgres psql agencybook_db

# Verify row counts match expectation:
sudo -u postgres psql agencybook_db -c "SELECT COUNT(*) FROM agencies;"
sudo -u postgres psql agencybook_db -c "SELECT COUNT(*) FROM visitors;"
sudo -u postgres psql agencybook_db -c "SELECT COUNT(*) FROM students;"
```

### 3. Restore uploads
```bash
# As agencybook user:
cd /home/agencybook
tar -xzf /tmp/files_2026-05-02_0200.tar.gz
# This restores the `uploads/` directory in place
ls uploads | head   # spot-check that files exist
```

### 4. Pull app code
```bash
sudo -u agencybook bash
cd /home/agencybook/app
git clone https://github.com/<your-org>/agencybook.git .
cd agency-os-backend
npm ci --production
```

### 5. Restore `.env`
Create `/home/agencybook/app/agency-os-backend/.env` from the secrets vault. The same `JWT_SECRET` and `ENCRYPTION_KEY` must be used — using a fresh `ENCRYPTION_KEY` will leave all PII unreadable. Verify with the inventory in `deploy/SECRETS.md`.

### 6. Start with PM2
```bash
cd /home/agencybook/app/agency-os-backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd  # follow the printed instruction to make pm2 boot on reboot
```

### 7. Frontend + nginx
```bash
cd /home/agencybook/app/agency-os
npm ci
npm run build
sudo cp -r dist/* /var/www/demo.agencybook.net/

# nginx vhost (copy from old server's /etc/nginx/sites-available/ if available):
sudo systemctl reload nginx
```

Re-run certbot to issue fresh TLS certs:
```bash
sudo certbot --nginx -d demo.agencybook.net -d demo-api.agencybook.net
```

### 8. Smoke test BEFORE switching DNS
While DNS still points to the old server, hit the new server's IP directly:
```bash
curl -k --resolve demo-api.agencybook.net:443:<new-ip> https://demo-api.agencybook.net/api/health
```
Expected: `{"ok": true, "db": "ok", ...}`. Log in via the UI using the same `--resolve` flag in browser dev tools or test with the auth smoke script.

### 9. Cut over DNS
Update Cloudflare A records → new IP. TTL was already 300s if you followed the playbook, so propagation is ~5 min.

### 10. Post-cutover verification
- [ ] `bash scripts/smoke-test.sh` (project-root) — all 14 public domains green
- [ ] `bash scripts/smoke-test-auth.sh` — JWT login + reads work
- [ ] `bash scripts/smoke-test-e2e.sh` — Playwright Visitor create/delete works
- [ ] PII spot-check: open one Visitor, confirm passport_number renders as plaintext (decryption working = ENCRYPTION_KEY matches what the data was encrypted with)
- [ ] Activity log has new `restore-system` entry → file an incident postmortem

## How to restore — single-table or single-row

Common case: someone deleted a Visitor unintentionally and the soft-delete restore window is over.

```bash
# 1. Spin up the dump in a SCRATCH database (don't touch prod):
sudo -u postgres psql -c "CREATE DATABASE agencybook_scratch;"
gunzip < /home/agencybook/backups/db_2026-04-30_0200.sql.gz | sudo -u postgres psql agencybook_scratch

# 2. Extract the row(s) of interest:
sudo -u postgres psql agencybook_scratch -c "\copy (SELECT * FROM visitors WHERE id = '<uuid>') TO '/tmp/visitor.csv' CSV HEADER;"

# 3. Inspect & re-insert into prod (manually craft INSERT to avoid PK conflicts):
# Use \copy or write a one-off SQL file. Always wrap in a transaction.

# 4. Drop the scratch DB:
sudo -u postgres psql -c "DROP DATABASE agencybook_scratch;"
```

## Backup-restore drill (quarterly)

Goal: catch backup-corruption issues before a real disaster. Spend 60 min on the 1st Monday of each quarter.

1. Spin up a temporary VM (Vultr / Digital Ocean $5 droplet) or a Docker postgres container locally.
2. Pull the most recent off-site backup (NOT the local one — we want to test the off-site path).
3. Run steps 1-3 of "How to restore — full system" against the temp VM.
4. Smoke test: `psql` count rows on `agencies`, `visitors`, `students`, `activity_log`. Compare to known prod counts (post a Slack/email summary at month-end with these counts so you have a baseline).
5. Decrypt one PII row using a debug script — proves the off-site `ENCRYPTION_KEY` recovery path works.
6. Tear down the temp VM. File a one-line "drill passed YYYY-MM-DD" entry in `docs/incidents/drills.md`.

If a drill fails: investigate immediately. A failed drill is a P0 incident — you don't have a backup until you've proven you can restore it.

## What's NOT covered (gaps to address)

| Gap | Mitigation today | Long-term fix |
|---|---|---|
| No streaming WAL archive — RPO is 24 hours (last nightly backup) | Reduce loss window via more frequent backups (hourly cron) | Set up `pg_basebackup` + WAL archiving to off-site; RPO drops to <5 min |
| Single off-site provider | rclone to one B2/R2 bucket | Add a second provider (3-2-1 rule) — e.g., B2 + S3 Glacier |
| No automated drill | Manual quarterly | Schedule the drill via the project `/schedule` skill so it auto-creates a checklist issue |
| `.env` not in any vault | Currently a markdown handoff | Adopt 1Password Secrets Automation or HashiCorp Vault per `deploy/SECRETS.md` |
| Uploads directory grows unbounded | tar size grows with usage | Move uploads to R2 (project memory says STORAGE_BACKEND=mirror is live in prod) — backup script can then skip the tar step |

## Quick reference

| I want to… | Run this |
|---|---|
| Take a backup right now | `ssh agencybook /home/agencybook/backup_with_files.sh` |
| List recent backups | `ssh agencybook 'ls -lh /home/agencybook/backups/'` |
| Pull yesterday's backup locally | (project skill) `bash scripts/db-backup` |
| Restore one row | See "How to restore — single-table" above |
| Full disaster restore | See "How to restore — full system" above |
| Verify off-site copy exists | `rclone ls remote:agencybook-backups/ | tail` |
