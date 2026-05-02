# Secrets Management & Rotation — AgencyBook Backend

This runbook covers every secret the backend depends on: where it lives, who can read it, when to rotate it, and how to do so without downtime.

## Inventory

| Secret | Used by | Storage (today) | Severity if leaked |
|---|---|---|---|
| `JWT_SECRET` | Signs every auth token | `.env` on VPS | HIGH — full account takeover for all tenants |
| `ENCRYPTION_KEY` | AES-256-GCM for PII (passport, NID, phone, address, family names, bank info) | `.env` on VPS | CRITICAL — historical PII can be decrypted |
| `DATABASE_URL` | Postgres connection string (includes password) | `.env` on VPS | HIGH — direct DB access |
| Per-agency BYOK keys (`ANTHROPIC_API_KEY`, `SMTP_*`, `R2_*`, Stripe) | Stored AES-encrypted in `agency_integrations` table, keyed by `ENCRYPTION_KEY` | Database | MED — costs the affected tenant; rotate-able by them |
| `VAPID_PRIVATE_KEY` | Web Push signing | `.env` on VPS | LOW — push notifications only |
| `SUPABASE_SERVICE_ROLE_KEY` (legacy) | Historical name in `lib/supabase.js`; we actually use local Postgres now | `.env` on VPS | unused — remove during next rotation |

## Where secrets live

- `agency-os-backend/.env` on VPS (gitignored — confirmed in `.gitignore`)
- `agency-os-backend/.env.example` (committed — template only, no real values)
- GitHub Actions: secrets configured in repo settings → Settings → Secrets and variables → Actions
- Local dev: `agency-os-backend/.env.local` (gitignored)

## Generating fresh values

```bash
# JWT_SECRET — 64 hex bytes (512 bits)
openssl rand -hex 64

# ENCRYPTION_KEY — exactly 64 hex characters (256 bits / 32 bytes)
openssl rand -hex 32

# Web Push VAPID pair (regenerate both keys together)
npx web-push generate-vapid-keys
```

## Rotation procedures

### A. Rotating `JWT_SECRET` (zero-downtime)

Effect: every active session token becomes invalid → all users get logged out and must log in again.

1. Generate new value: `openssl rand -hex 64`
2. SSH to VPS, edit `.env`, **append** as `JWT_SECRET_NEXT=<new>` while keeping the old `JWT_SECRET`.
3. Add a brief code change (one PR) to verify against both keys: try `JWT_SECRET` first, fall back to `JWT_SECRET_NEXT`. Sign new tokens with `JWT_SECRET_NEXT`.
4. Deploy. Wait 1× the JWT TTL (default 7 days) so all old tokens expire.
5. Promote: rename `JWT_SECRET_NEXT` → `JWT_SECRET`, drop the dual-verify code.
6. Run smoke test: `bash scripts/smoke-test-auth.sh`

If you must rotate **immediately** (suspected compromise): just replace the value and `pm2 reload`. Every user will be logged out — accept the support spike.

### B. Rotating `ENCRYPTION_KEY` (NOT zero-downtime — requires data migration)

⚠️ **Read this entire section before starting. Wrong order will permanently corrupt PII.**

The encryption format is `iv:authTag:ciphertext`; ciphertext can only be decrypted with the key it was written with. Rotating the key requires re-encrypting every existing row.

1. **Take a full DB backup first** — `bash scripts/db-backup` (project skill). Verify the dump file exists and is non-zero.
2. Put the system into maintenance mode (Nginx 503 page, or a feature flag that blocks writes).
3. Generate new key: `openssl rand -hex 32`
4. Set `ENCRYPTION_KEY_OLD=<current>` and `ENCRYPTION_KEY=<new>` in `.env`. Do NOT remove the old key yet.
5. Run a re-encryption script (write one ad-hoc; pseudo:
   ```js
   // for each table containing SENSITIVE_FIELDS, for each row:
   //   plaintext = decryptWithOld(row.field)
   //   row.field = encryptWithNew(plaintext)
   //   UPDATE SET field = ...
   ```
   Use a transaction per table; commit only when the whole table re-encrypts cleanly. The current `crypto.js` already has `decrypt()` accepting a `:`-formatted ciphertext — just temporarily wire it to use the OLD key during the migration.
6. Run smoke: log into any test tenant, open a Visitor record, confirm passport/phone read correctly.
7. Remove `ENCRYPTION_KEY_OLD` from `.env`. Delete the migration script. `pm2 reload`.
8. Lift maintenance mode.

If a partial rotation fails (some rows new, some old): **restore from the backup taken in step 1**. Don't try to "fix forward" — the mixed state is unrecoverable without lineage tracking we don't currently have.

### C. Rotating `DATABASE_URL` password

1. Inside Postgres: `ALTER USER agencybook WITH PASSWORD '<new>';`
2. Update `.env` on VPS with new password in connection string.
3. `pm2 reload ecosystem.config.js --update-env`
4. Verify: `curl https://demo-api.agencybook.net/api/health` returns 200 with `db: "ok"`.
5. Update GitHub Actions secret `VPS_DB_PASSWORD` (if used by any workflow).

### D. Rotating per-agency BYOK keys

Tenants do this themselves via Settings → Integrations in the UI. The flow:
1. Tenant pastes new key.
2. Backend encrypts with `ENCRYPTION_KEY`, stores in `agency_integrations.value_encrypted`.
3. The provider's old key remains valid until the tenant revokes it on the provider side (Anthropic console, Stripe dashboard, etc.).

No platform action needed unless a tenant reports inability to update — in which case check the integrations route logs.

## Routine schedule

| Secret | Cadence | Trigger |
|---|---|---|
| `JWT_SECRET` | Every 90 days, or on suspected compromise | Calendar reminder |
| `ENCRYPTION_KEY` | Annually, or on suspected compromise | Calendar reminder |
| `DATABASE_URL` password | Every 180 days | Calendar reminder |
| VAPID keys | Only on compromise (rotation forces all subscriptions to re-register) | Manual |
| GitHub Actions deploy SSH key | Every 90 days | Calendar reminder |

## Incident response — suspected leak

1. **Identify scope.** Was it `.env` exposure, a developer machine, a stolen backup, GitHub secret leak?
2. **Rotate the single affected secret first** using the procedure above.
3. **Audit access logs**: `psql … -c "SELECT * FROM activity_log WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 500"`. Look for unfamiliar IPs or unusual data exports.
4. If `ENCRYPTION_KEY` was leaked: assume historical PII is compromised. Notify affected agencies in writing (legal obligation under most data-protection regimes, including Bangladesh's draft DPA). Rotate the key per section B.
5. File a postmortem in `docs/incidents/<YYYY-MM-DD>-<slug>.md`.

## Pre-flight checklist before EVERY production deploy

- [ ] `.env` is NOT in `git status` output (should be gitignored)
- [ ] No `console.log(process.env...)` lines added in this PR
- [ ] No secret values pasted into code, tests, fixtures, or markdown
- [ ] `git log --all -p | grep -E "(JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL)"` returns nothing real
- [ ] If a new env var was added, `.env.example` was updated to document it (no real value)

## Long-term: move secrets out of `.env`

`.env` on a single VPS is acceptable for the current deployment. When AgencyBook scales to multi-server or has a stricter compliance customer (e.g., enterprise with SOC 2 ask), migrate to:

- **HashiCorp Vault** (self-hosted, free) — best fit for this stack
- **AWS Secrets Manager / GCP Secret Manager** — if cloud-hosted
- **Doppler / Infisical** — SaaS, easy onboarding

The application code already reads everything via `process.env.X` — switching backends requires only the env-loading layer in `app.js`.
