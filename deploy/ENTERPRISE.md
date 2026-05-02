# Enterprise Install — Operator Runbook

This guide is for setting up a **dedicated VPS install** for an Enterprise
customer. It's a single-tenant deployment: the customer gets their own
backend, frontend, database, and uploads — separate from the shared SaaS
on `*.agencybook.net`.

In Enterprise mode there is **no Super Admin** — the agency Owner is the
top role. They configure all API keys (Anthropic / SMTP / R2) themselves
through Settings → Integrations. The platform absorbs zero usage cost.

## Prerequisites

- A Linux VPS (Contabo, Hetzner, AWS EC2, etc.) — 2 GB RAM minimum, 4 GB
  recommended for cluster mode
- Domain or subdomain for the customer (e.g. `acme.example.com`)
- DNS A record pointing at the VPS IP
- Postgres 14+ (can be the same VPS or external)
- Node 20+

## Step 1 — Bootstrap the VPS

```bash
ssh root@<vps-ip>
adduser <customer>           # e.g. acme
usermod -aG sudo <customer>
mkdir -p /home/<customer>/{backend,frontend,uploads,logs,backups}
chown -R <customer>:<customer> /home/<customer>
```

## Step 2 — Clone repos and install deps

```bash
sudo -u <customer> -i
cd /home/<customer>
git clone <BACKEND_REPO_URL> backend
cd backend
npm install --production --legacy-peer-deps

cd /home/<customer>
git clone <FRONTEND_REPO_URL> frontend
cd frontend
npm install --legacy-peer-deps
```

## Step 3 — Database

Create a Postgres role + database for the customer:

```bash
sudo -u postgres psql <<EOF
CREATE USER <customer> WITH PASSWORD '<strong-password>';
CREATE DATABASE <customer>_db OWNER <customer>;
EOF
```

Apply schema and migrations:

```bash
cd /home/<customer>/backend
PGPASSWORD='<strong-password>' psql -h 127.0.0.1 -U <customer> -d <customer>_db -f deploy/schema.sql
for m in deploy/migration_*.sql; do
  PGPASSWORD='<strong-password>' psql -h 127.0.0.1 -U <customer> -d <customer>_db -f "$m"
done
```

## Step 4 — `.env`

Create `/home/<customer>/backend/.env`:

```ini
# Core
NODE_ENV=production
PORT=5010                                # pick a free port; reverse proxy maps to it
DATABASE_URL=postgres://<customer>:<password>@127.0.0.1:5432/<customer>_db
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)   # 64 hex chars = 256 bits

# Multi-tenancy mode
INSTANCE_MODE=enterprise                 # IMPORTANT: dedicated install

# Storage
STORAGE_BACKEND=local                    # or 'mirror' if R2 already wired
UPLOADS_DIR=/home/<customer>/uploads

# CORS (whitelist customer's frontend domain)
CORS_ORIGIN=https://acme.example.com

# Rate limit (optional override — leave default if unsure)
# API_RATE_LIMIT=200
```

**Do NOT** add `ANTHROPIC_API_KEY`, `SMTP_*`, `R2_*` to this `.env`. In
enterprise mode there's no platform fallback — those keys go through the
customer's Settings → Integrations.

## Step 5 — Provision the agency + owner user

```bash
cd /home/<customer>/backend
node scripts/provision-enterprise.js \
  --agency-name "Acme Study Abroad" \
  --agency-name-bn "অ্যাকমে স্টাডি অ্যাব্রোড" \
  --subdomain acme \
  --owner-name "Acme Owner" \
  --owner-email owner@acme.com \
  --owner-password "<initial password>"
```

The script outputs the agency ID and login credentials. Save these and
deliver them securely to the customer (encrypted email, password manager
share, etc.).

## Step 6 — Frontend build

```bash
cd /home/<customer>/frontend
# .env.production: API_URL points at the customer's backend
echo "VITE_API_URL=https://acme-api.example.com/api" > .env.production
npm run build
```

## Step 7 — Process manager (PM2)

```bash
cd /home/<customer>/backend
pm2 start src/app.js --name <customer>-api -i 2 --update-env
pm2 save
pm2 startup    # follow the printed command to enable on boot
```

For the frontend (static files served via nginx), no PM2 needed.

## Step 8 — Nginx reverse proxy

Two vhosts: one for the API, one for the frontend.

```nginx
# /etc/nginx/sites-available/acme-api
server {
    listen 443 ssl http2;
    server_name acme-api.example.com;
    ssl_certificate     /etc/letsencrypt/live/acme-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/acme-api.example.com/privkey.pem;
    client_max_body_size 50M;
    location / {
        proxy_pass http://127.0.0.1:5010;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# /etc/nginx/sites-available/acme-frontend
server {
    listen 443 ssl http2;
    server_name acme.example.com;
    ssl_certificate     /etc/letsencrypt/live/acme.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/acme.example.com/privkey.pem;
    root /home/<customer>/frontend/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/acme-* /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d acme.example.com -d acme-api.example.com
```

## Step 9 — Backups

Reuse the project's backup script (one per customer):

```bash
# /home/<customer>/backup.sh
#!/bin/bash
BACKUP_DIR=/home/<customer>/backups
mkdir -p $BACKUP_DIR
DATE=$(date +%Y%m%d_%H%M)
DB_PASS=$(grep DATABASE_URL /home/<customer>/backend/.env | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
PGPASSWORD=$DB_PASS pg_dump -h 127.0.0.1 -U <customer> <customer>_db | gzip > $BACKUP_DIR/db_$DATE.sql.gz
tar czf $BACKUP_DIR/files_$DATE.tar.gz -C /home/<customer> uploads
find $BACKUP_DIR -name 'db_*.sql.gz' -mtime +14 -delete
find $BACKUP_DIR -name 'files_*.tar.gz' -mtime +14 -delete
```

Crontab:
```cron
0 3 * * *  bash /home/<customer>/backup.sh
```

## Step 10 — Customer first-login

Customer logs in at `https://acme.example.com` with the credentials from
Step 5. They will see a yellow banner across the top:

> **Setup incomplete — Configure your integrations**
> AI (Anthropic), Email (SMTP) এখনো configure হয়নি — এই feature-গুলো এখনই কাজ করবে না।
> [Configure →]

They click **Configure**, navigate to **Settings → Integrations**, and
enter their credentials for:

- **Anthropic** — Claude API key (required for AI translation, OCR field
  extraction, Excel template AI analysis)
- **SMTP** — outbound email (required for password reset, notifications)
- **R2** *(optional)* — cloud storage mirror (only if STORAGE_BACKEND=mirror)
- **Stripe** *(optional)* — payment collection from students

Until the required ones are configured, those features show
"Configure in Settings → Integrations" errors instead of working.

## Updating an Enterprise install

```bash
ssh -i <key> root@<vps-ip>
sudo -u <customer> -i
cd /home/<customer>/backend
git pull origin main
npm install --production --legacy-peer-deps
# Apply any new migration_*.sql
for m in deploy/migration_*.sql; do
  PGPASSWORD=$DB_PASS psql -h 127.0.0.1 -U <customer> -d <customer>_db -f "$m"
done
pm2 restart <customer>-api --update-env

cd /home/<customer>/frontend
git pull origin main
npm install --legacy-peer-deps
npm run build
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Owner sees "Configure in Settings → Integrations" everywhere | Expected — they haven't BYOK'd. Once they save Anthropic + SMTP, features activate. |
| `[storage] backend = local` in logs but you wanted mirror | Set `STORAGE_BACKEND=mirror` in `.env`, install `@aws-sdk/client-s3`, restart PM2. |
| `R2 credentials missing` on boot | Either `STORAGE_BACKEND=local` (don't need R2) or configure R2 via the customer's Settings → Integrations. |
| `provision-enterprise.js` errors with "INSTANCE_MODE not enterprise" | Cosmetic warning. The script proceeds. To suppress, set `INSTANCE_MODE=enterprise` before running. |
| Customer changed their Anthropic key, but app still uses the old one | Cached. PM2 restart picks up the change immediately on next request. |

## What you're committing to

- **Per-customer ops**: each Enterprise install is a separate VPS to
  monitor, back up, and update.
- **Customer-paid integrations**: customer pays Anthropic, Cloudflare, SMTP
  provider directly — your usage cost is zero.
- **Customer-managed credentials**: you don't see their keys (they're
  encrypted in their own DB).
- **Roughly 30 min** per Enterprise install once you've done one.

## Long-term: when you have many Enterprise installs

Consider Ansible/Terraform automation for steps 1-9. The provisioning
script + ENTERPRISE.md are intentionally close to the metal so you can
audit and customize per customer before automating.
