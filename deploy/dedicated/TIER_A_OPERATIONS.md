# Tier A — Dedicated Cloud Operations Guide

**Status:** Phase 1 implementation
**Companion:** Phase 0 licensing foundation must be applied first
**Audience:** AgencyBook operator (you)

---

## What Tier A is

Each customer gets:

- Their own subdomain: `<slug>.agencybook.net`
- Their own API: `<slug>-api.agencybook.net`
- Their own PostgreSQL DB (`agencybook_<slug>`)
- Their own PM2 process on auto-assigned port (5100-5199 range)
- Their own `.env` with isolated secrets (DB password, JWT secret, encryption key)
- A license row with `max_agencies = 1` — they cannot create additional agencies

What's **shared** across all Tier A tenants:

- The frontend static bundle (`/home/agencybook/frontend/dist/`) — `api.js`
  auto-routes to `<slug>-api.agencybook.net` based on hostname
- The wildcard `*.agencybook.net` nginx vhost
- The Sentry DSN (errors aggregated centrally; tag carries the instance slug)

---

## One-time DNS prerequisites

In Cloudflare DNS for `agencybook.net`, ensure these wildcard records exist:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `*` | `161.97.175.16` | DNS-only (grey) |
| A | `*-api` | `161.97.175.16` | DNS-only (grey) |

The single wildcard `*` covers both — but most providers won't pattern-match
across hyphens. Add the explicit `*-api` record to be safe.

DNS-only (grey cloud) is required so certbot can issue Let's Encrypt certs;
proxy-mode breaks ACME validation.

---

## Provision a new tenant

```bash
bash scripts/provision-dedicated.sh \
  --slug acme \
  --agency-name "Acme Education" \
  --agency-name-bn "অ্যাকমে এডুকেশন" \
  --admin-name "MD Rahim Khan" \
  --admin-email rahim@acme-edu.com \
  --phone "+8801712345678"
```

Takes ~3-5 minutes. The script is idempotent — safe to re-run if it fails partway.

After completion you'll see a temp password in the output. Send credentials to
the customer through a secure channel and tell them to change on first login.

### Skipping SSL (DNS not propagated)

```bash
bash scripts/provision-dedicated.sh ... --skip-ssl
# Later, after DNS propagates (check with `dig +short <slug>-api.agencybook.net`):
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16 \
  "certbot --nginx -d <slug>-api.agencybook.net"
```

---

## List all tenants

```bash
bash scripts/list-tenants.sh
```

Shows slug, port, PM2 status, DB size, uploads size, last restart time.

---

## Update a tenant's code

Until Phase 2 (centralized update distribution) lands, the recommended pattern
for updating a single tenant is:

```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16 << 'REMOTE'
cd /home/agencybook/instances/<slug>
sudo -u agencybook bash -c "
  rsync -a --exclude=node_modules --exclude=.env --exclude=uploads \
    /home/agencybook/backend/ ./
  npm install --omit=dev --no-audit
"
sudo -u agencybook pm2 reload agency-<slug>-api --update-env
REMOTE
```

Phase 2 will replace this with `safe-update.sh` (backup + verify + rollback).

---

## Upgrade a tenant's license (allow multi-tenant or feature unlock)

```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16 << 'REMOTE'
cd /home/agencybook/instances/<slug>
sudo -u agencybook node scripts/seed-license.js \
  --instance <slug> \
  --max-agencies 5
REMOTE
# Restart for the change to take effect (license cache is 60s anyway):
ssh ... "sudo -u agencybook pm2 reload agency-<slug>-api"
```

---

## Backup a single tenant DB

```bash
ssh -i ~/.ssh/agencybook_vps root@161.97.175.16 \
  "sudo -u postgres pg_dump agencybook_<slug> | gzip > /tmp/<slug>-$(date +%F).sql.gz"
scp -i ~/.ssh/agencybook_vps \
  root@161.97.175.16:/tmp/<slug>-*.sql.gz ./backups/
```

The central daily backup cron currently dumps `agencybook_db` only — Tier A DBs
are not yet covered. Phase 7 (Backup, DR, Telemetry) extends the cron to enumerate
all `agencybook_*` databases.

---

## Restart / debug a tenant

```bash
ssh ... "sudo -u agencybook pm2 logs agency-<slug>-api --lines 100 --nostream"
ssh ... "sudo -u agencybook pm2 restart agency-<slug>-api"
ssh ... "sudo -u agencybook pm2 stop agency-<slug>-api"
```

Direct DB access:

```bash
ssh ... "sudo -u postgres psql -d agencybook_<slug>"
```

---

## Deprovision a tenant

**Always** export customer data first (Phase 5 self-service tool, when built;
for now, manual `pg_dump` + decrypt PII fields).

```bash
bash scripts/deprovision-dedicated.sh --slug acme --confirm DESTROY
```

This:

1. Takes a final encrypted DB backup → `/home/agencybook/backups/archived/`
2. Stops + removes the PM2 process
3. Disables the nginx vhost
4. Deletes the Let's Encrypt cert
5. Drops the database and role
6. Archives the instance directory
7. Removes the instance directory

The DB dump and code archive are kept on VPS for compliance. Sweep them to
off-site storage + delete after your data-retention window (Phase 5/7 work).

---

## Resource budget

A single Contabo VPS with 12GB RAM / 6 cores comfortably hosts:

- ~10-15 active Tier A tenants (256MB max per PM2 process = 2.5-4GB)
- + the central shared SaaS (`agencybook-api` cluster x4 = 2GB)
- + the dev instance (`agencybook-api-dev` = 256MB)
- + Postgres, nginx, Uptime Kuma, Sentry agent (combined ~2GB)
- ~2-3GB headroom

When you hit ~12 active tenants and free RAM falls below 2GB, plan a horizontal
split: provision a second VPS and route new tenants there via DNS.

---

## What's NOT in Tier A (handled in later phases)

- ✗ Centralized update distribution (Phase 2)
- ✗ Operator console / fleet dashboard (Phase 3)
- ✗ Customer onboarding wizard (Phase 4)
- ✗ Self-service customer data export (Phase 5)
- ✗ Customer-managed VPS (Tier B — Phase 6)
- ✗ Encrypted off-site backups (Phase 7)
- ✗ Legal templates + status page (Phase 8/9)
- ✗ True on-premise Docker stack (Phase 14)
