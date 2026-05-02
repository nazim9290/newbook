# Storage backend — local FS, Cloudflare R2, or both (mirror)

The backend writes uploaded templates and other files through
`lib/storage/index.js` — a thin facade that picks one of three backends
based on `STORAGE_BACKEND` in `.env`.

## Three modes

| Mode | What it does | When to use |
|---|---|---|
| `local` | Writes only to VPS filesystem | Dev machine, cheapest, no cloud dep |
| `r2` | Writes only to Cloudflare R2 | Multi-region, ephemeral VPS, big scale |
| `mirror` | **Writes to both** — local primary, R2 secondary | **Recommended** — durability + speed |

The `mirror` mode is what production should run. Reads come from local
disk (fast, free), but every write is also pushed to R2 so a disk crash
or VPS migration can't lose anything. Deletes go to both — no orphans.

## Mirror mode details

**Write path:**
1. Save to local disk — must succeed, this is the source of truth for reads
2. Save to R2 — best-effort. If R2 is unreachable, log `[mirror:drift]`
   and continue. The user-facing request still succeeds.

**Read path:**
1. Try local disk — fastest
2. Local miss → fetch from R2 → write back to local (self-heal)
   So if local disk is wiped, the first time each file is requested
   it gets restored automatically.

**Delete path:**
- Best-effort delete from both. Either failing logs a warning but does
  not abort the other. We'd rather over-delete than leak.

**Why this shape:**
- Reads stay fast and free (local disk, no R2 egress)
- Writes are doubled, but xlsx/docx average <500 KB → R2 upload completes
  in ~100-300 ms, well within an HTTP request budget
- VPS disk crash → R2 still has everything; first request rebuilds local
- R2 outage → local writes keep working; failed mirror ops surface in
  logs and get replayed via `scripts/storage-reconcile.js`

## Setup — production: `mirror` mode

### 1. R2 bucket + API token (one-time, on Cloudflare dashboard)

1. Cloudflare R2 → create bucket `agencybook-uploads`
2. **R2 → Manage R2 API Tokens → Create Account API Token**
   - Permissions: **Object Read & Write**
   - Specify bucket: `agencybook-uploads`
   - TTL: blank
3. Save **Access Key ID**, **Secret Access Key**, and **Account ID** from
   the endpoint URL `https://<account-id>.r2.cloudflarestorage.com`.

### 2. VPS — install AWS SDK

```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16
cd /home/agencybook/backend
npm install --legacy-peer-deps @aws-sdk/client-s3
```

(Backend works without this package while `STORAGE_BACKEND=local`. It's
required only for `r2` and `mirror` modes.)

### 3. `.env` on VPS

```
# Storage backend selection
STORAGE_BACKEND=mirror
UPLOADS_DIR=/home/agencybook/uploads

# R2 credentials — needed when STORAGE_BACKEND is r2 or mirror
R2_ACCOUNT_ID=<from cloudflare>
R2_ACCESS_KEY_ID=<from token creation>
R2_SECRET_ACCESS_KEY=<from token creation>
R2_BUCKET=agencybook-uploads
```

### 4. Bulk-seed existing files into R2 (one-time)

If you've been running in `local` mode for a while, push the historical
files up before flipping the env:

```bash
cd /home/agencybook/backend
node scripts/migrate-uploads-to-r2.js
```

The script is idempotent (skips files already in R2) and rewrites any
DB rows still holding absolute paths.

### 5. Flip and restart

```bash
# .env now has STORAGE_BACKEND=mirror
su - agencybook -c "pm2 restart agencybook-api --update-env"
```

Verify the boot log:
```
[storage] backend = mirror (local=/home/agencybook/uploads, r2=agencybook-uploads)
```

### 6. Smoke test

Upload a new template via the app. Watch the log: should see no
`[mirror:drift]` warnings. Use the Cloudflare R2 dashboard to confirm
the new key appears.

### 7. Reconcile periodically

`scripts/storage-reconcile.js` reports drift between local and R2,
and optionally repairs it.

```bash
# Just report (default)
node scripts/storage-reconcile.js

# Push local-only files to R2
node scripts/storage-reconcile.js --fix-r2

# Pull R2-only files to local (e.g. after restoring a wiped VPS)
node scripts/storage-reconcile.js --fix-local

# Both directions
node scripts/storage-reconcile.js --fix-all
```

Recommended cron (root crontab on VPS):
```cron
# Nightly drift report — alerts via email if exit code != 0
0 3 * * *  cd /home/agencybook/backend && node scripts/storage-reconcile.js >> /home/agencybook/logs/storage-reconcile.log 2>&1
```

## Disaster scenarios

| Scenario | What happens | Recovery |
|---|---|---|
| Local subfolder accidentally `rm -rf`'d | Reads silently rebuild from R2 on demand | Run `scripts/storage-reconcile.js --fix-local` to bulk-restore |
| R2 outage / token revoked | Writes log `[mirror:drift]`, reads work from local | Fix credentials, run `--fix-r2` to replay missed writes |
| VPS dies entirely (disk gone) | Provision fresh VPS, set env vars, run `--fix-local` | All files restored from R2 before backend serves traffic |
| Cloudflare R2 region down | Reads fall back to local; writes log drift | Wait for R2 SLA recovery; reconciliation auto-replays |
| File deleted by user | Both copies removed (mirror dual-delete) | Recover from your DB backup + last known R2 versioning point (enable R2 Object Versioning if you need this) |

## Going Enterprise — what changes as the project scales

Today's setup is right for ~1-100 agencies. The same code paths support
much higher scale by toggling environment variables and adding pieces.

### 1. Multi-tenancy at scale

**Now:** All agencies share one bucket; filenames are prefixed with `<agency_id>_<ts>_<file>`.
**Enterprise option A (simpler):** Keep one bucket, group by key prefix:
- `excel-templates/agency-XXX/<file>`
- Set CloudFront/Cloudflare cache behaviors per prefix
- Backup/audit policies can target a prefix

**Enterprise option B (stronger isolation):** One R2 bucket per
*paying tier* (free / pro / enterprise) — Cloudflare allows ~1000
buckets per account.

**Bucket-per-agency** is rarely needed unless a customer demands
isolated billing or jurisdiction-locked storage.

### 2. Throughput / latency

- **Cloudflare CDN in front of R2** — turn on the `r2.dev` public access
  or attach a custom hostname; reads served from the edge globally
  (sub-50 ms anywhere)
- **Signed URLs** for downloads — backend issues a 5-minute-valid R2
  URL, browser fetches directly. Reduces backend bandwidth costs at
  enterprise scale.

### 3. Compliance / audit

- **R2 Object Versioning** — every overwrite/delete keeps the prior
  version for N days. Useful for GDPR right-to-recovery.
- **Activity log integration** — already wired: `logActivity()` records
  every CRUD. Add per-storage-op logging if compliance demands "who
  read what file when".
- **Region pinning** — Cloudflare offers EU / FedRAMP-aligned R2 if
  customer data residency requirements show up.

### 4. Operational maturity

| Today | Enterprise upgrade |
|---|---|
| Storage drift reconciliation = nightly cron | Real-time replay queue (failed mirror ops → DB-backed retry) |
| Logs to disk, grep manually | Stream to OpenSearch / Datadog; alert on `[mirror:drift]` rate |
| Smoke test = run script | Synthetic monitoring: every 5 min, upload+download a test object, alert on failure |
| Backup = R2 itself | Cross-region replication: R2 → S3 weekly snapshot |

### 5. Cost shape as you scale

Cloudflare R2 free tier (today's reality):
- 10 GB storage
- 1 M Class A operations/mo (writes/lists)
- 10 M Class B operations/mo (reads)
- **Zero egress fees** (this is the big differentiator vs S3)

For ~1000 agencies, ~10 templates each, average 500 KB → ~5 GB. Still
inside free tier. You pay R2 only after ~20 GB *or* high op volume.

### 6. When to consider full migration to `r2` (drop local)

When any of these hits:
- VPS disk costs > R2 storage costs
- You want zero-downtime VPS replacement (no rebuild step)
- Multiple backend instances behind a load balancer (local FS doesn't
  share between them; R2 does)
- Compliance demands off-server immutability

Migration is just `STORAGE_BACKEND=r2` + restart. The reconcile script
ensures both stores are in sync before flipping. Roll back the same way.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `[storage] backend = local` after setting `STORAGE_BACKEND=mirror` | `.env` not picked up; PM2 not restarted with `--update-env` | `pm2 restart agencybook-api --update-env` |
| `R2 credentials missing` on PM2 boot | `STORAGE_BACKEND=mirror` set but `R2_*` vars forgotten | Add `R2_*` to `.env`, restart |
| `[mirror:drift]` lines in logs | R2 write failed (transient or token issue) | Run `scripts/storage-reconcile.js --fix-r2` after fixing root cause |
| `[mirror:rebuild]` lines in logs | Local file was missing, restored from R2 | Cosmetic — system self-healed. If frequent, investigate why local FS is losing files |
| `Template file পাওয়া যায়নি` on download | DB row points to a key that exists in NEITHER store | Re-upload the template; check `scripts/storage-reconcile.js` ORPHAN_DB report |
