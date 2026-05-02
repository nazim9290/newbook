#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# safe-update.sh — Phase 2 Update Distribution
# ═══════════════════════════════════════════════════════════════════════
#
# Pre-update backup → git pull → npm install → run new migrations →
# pm2 reload → health check → AUTO-ROLLBACK on failure.
#
# Two execution contexts:
#   1. Central VPS:  bash /home/agencybook/safe-update.sh backend
#   2. Tier A tenant: bash /home/agencybook/instances/<slug>/safe-update.sh
#
# Triggered by:
#   - admin clicks "Update Now" in UI → /api/system/update-now spawns this
#   - cron critical-update auto-apply (Phase 5/13 follow-up)
#   - operator manually
#
# ENV inputs (auto-detected if unset):
#   INSTANCE_DIR  /home/agencybook/backend OR /home/agencybook/instances/<slug>
#   PM2_NAME      agencybook-api OR agency-<slug>-api
#   HEALTH_PORT   5002 (central) OR per-tenant port from .env
# ═══════════════════════════════════════════════════════════════════════

set -uo pipefail   # 'e' off — we handle exit codes manually for rollback

TARGET="${1:-backend}"   # backend | frontend
LOG_FILE="/home/agencybook/logs/safe-update.log"
mkdir -p /home/agencybook/logs

log()  { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG_FILE"; }
die()  { log "FATAL: $1"; exit 1; }

# ── Detect context ─────────────────────────────────────────────────────
INSTANCE_DIR="${INSTANCE_DIR:-}"
if [[ -z "$INSTANCE_DIR" ]]; then
  # If invoked from inside an instance dir, use it; else default central
  if [[ -f "$(pwd)/src/app.js" && -f "$(pwd)/.env" ]]; then
    INSTANCE_DIR="$(pwd)"
  else
    INSTANCE_DIR="/home/agencybook/backend"
  fi
fi

PM2_NAME="${PM2_NAME:-}"
if [[ -z "$PM2_NAME" ]]; then
  if [[ "$INSTANCE_DIR" == "/home/agencybook/backend" ]]; then
    PM2_NAME="agencybook-api"
  else
    SLUG=$(basename "$INSTANCE_DIR")
    PM2_NAME="agency-${SLUG}-api"
  fi
fi

HEALTH_PORT="${HEALTH_PORT:-}"
if [[ -z "$HEALTH_PORT" ]]; then
  HEALTH_PORT=$(grep -E '^PORT=' "${INSTANCE_DIR}/.env" 2>/dev/null | cut -d= -f2)
  HEALTH_PORT="${HEALTH_PORT:-5002}"
fi

log "═══════════════════════════════════════════════════════════════"
log "safe-update.sh starting"
log "  TARGET:       $TARGET"
log "  INSTANCE_DIR: $INSTANCE_DIR"
log "  PM2_NAME:     $PM2_NAME"
log "  HEALTH_PORT:  $HEALTH_PORT"
log "═══════════════════════════════════════════════════════════════"

cd "$INSTANCE_DIR" || die "instance dir not found: $INSTANCE_DIR"

# ── 1. Pre-update backup ───────────────────────────────────────────────
log "[1/7] Backup ..."
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_DIR="/home/agencybook/backups/pre-update"
mkdir -p "$BACKUP_DIR"

# DB backup — extract DB name from DATABASE_URL
DB_NAME=$(grep -E '^DATABASE_URL=' .env | sed -E 's|.*/([^?]+)(\?.*)?$|\1|' | tr -d '\r')
if [[ -n "$DB_NAME" ]]; then
  BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_pre-update_${TIMESTAMP}.sql.gz"
  sudo -u postgres pg_dump "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_FILE" || \
    die "DB backup failed for $DB_NAME"
  log "    → DB backup: $BACKUP_FILE"
else
  log "    → could not detect DB_NAME from .env, skipping DB backup"
fi

# Git rev backup
PRE_REV=$(sudo -u agencybook git rev-parse HEAD)
log "    → pre-update git rev: $PRE_REV"

# ── 2. Git pull ────────────────────────────────────────────────────────
log "[2/7] Git pull ..."
sudo -u agencybook git fetch origin >/dev/null 2>&1 || die "git fetch failed"
NEW_REV=$(sudo -u agencybook git rev-parse origin/main)
if [[ "$PRE_REV" == "$NEW_REV" ]]; then
  log "    → already up-to-date ($PRE_REV)"
  log "✓ no update needed"
  exit 0
fi
sudo -u agencybook git pull origin main >/dev/null 2>&1 || die "git pull failed"
log "    → moved to: $NEW_REV"

# ── 3. npm install ─────────────────────────────────────────────────────
log "[3/7] npm install ..."
sudo -u agencybook npm install --omit=dev --no-audit --no-fund --silent || {
  log "    → npm install failed, rolling back"
  rollback "$PRE_REV"
}

# ── 4. Run any new migrations ──────────────────────────────────────────
log "[4/7] Migrations ..."
DB_USER=$(grep -E '^DATABASE_URL=' .env | sed -E 's|postgresql://([^:]+):.*|\1|')
DB_PASS=$(grep -E '^DATABASE_URL=' .env | sed -E 's|.*//[^:]+:([^@]+)@.*|\1|')
export PGPASSWORD="$DB_PASS"
PSQL="psql -U $DB_USER -h 127.0.0.1 -d $DB_NAME -v ON_ERROR_STOP=0 -q"

# Apply only migrations that newly arrived in this pull (best-effort)
NEW_MIGRATIONS=$(sudo -u agencybook git diff --name-only "$PRE_REV" "$NEW_REV" | grep -E 'deploy/migration_.*\.sql$' || true)
if [[ -n "$NEW_MIGRATIONS" ]]; then
  for m in $NEW_MIGRATIONS; do
    log "    → applying $m"
    $PSQL -f "$INSTANCE_DIR/$m" >/dev/null 2>&1 || log "      (warnings ignored)"
  done
else
  log "    → no new migrations in this update"
fi
unset PGPASSWORD

# ── 5. PM2 reload ──────────────────────────────────────────────────────
log "[5/7] PM2 reload $PM2_NAME ..."
sudo -u agencybook pm2 reload "$PM2_NAME" --update-env >/dev/null 2>&1 || {
  log "    → reload failed, rolling back"
  rollback "$PRE_REV"
}

# ── 6. Health check (60s timeout) ──────────────────────────────────────
log "[6/7] Health check on port $HEALTH_PORT ..."
HEALTHY=false
for i in $(seq 1 30); do
  sleep 2
  if curl -sf "http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null 2>&1; then
    HEALTHY=true
    log "    → ✓ healthy (attempt $i/30)"
    break
  fi
done

if [[ "$HEALTHY" != "true" ]]; then
  log "    → health check failed after 60s, rolling back"
  rollback "$PRE_REV"
fi

# ── 7. Done ────────────────────────────────────────────────────────────
log "[7/7] ✓ Update complete: $PRE_REV → $NEW_REV"
log "═══════════════════════════════════════════════════════════════"
exit 0

# ── Rollback function ──────────────────────────────────────────────────
rollback() {
  local rev="$1"
  log "═══ ROLLBACK to $rev ═══"
  sudo -u agencybook git reset --hard "$rev" >/dev/null 2>&1 || log "git reset failed"
  sudo -u agencybook npm install --omit=dev --no-audit --no-fund --silent || true
  sudo -u agencybook pm2 reload "$PM2_NAME" --update-env || true
  log "Rollback complete. System on $rev."
  exit 1
}
