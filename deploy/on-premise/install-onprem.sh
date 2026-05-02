#!/usr/bin/env bash
# Phase 14 (skeleton): One-line installer for Tier C on-premise.
#
# Customer pastes this in their terminal:
#   curl https://install.agencybook.net/onprem | bash -s LICENSE_KEY DOMAIN
#
# What this does (when fully built):
#   1. Verify Docker installed (else install)
#   2. Activate license against license.agencybook.net (binds hardware ID)
#   3. Generate per-customer secrets (DB pass, JWT, encryption key)
#   4. Pull cosign-signed images from ghcr.io/agencyos/*
#   5. Verify image signatures
#   6. Issue Let's Encrypt cert
#   7. docker compose up -d
#   8. Wait healthy, print success
#
# STATUS: skeleton. Needs license.agencybook.net + GHCR + Cosign before
# production use.

set -e

LICENSE_KEY="${1:-}"
DOMAIN="${2:-}"

if [[ -z "$LICENSE_KEY" || -z "$DOMAIN" ]]; then
  echo "Usage: curl https://install.agencybook.net/onprem | bash -s LICENSE_KEY DOMAIN"
  exit 1
fi

INSTALL_DIR="/opt/agencyos"
echo "═══════════════════════════════════════════════════════════════"
echo "  AgencyOS on-premise install (Phase 14 skeleton)"
echo "  License: ${LICENSE_KEY:0:8}..."
echo "  Domain:  $DOMAIN"
echo "  Target:  $INSTALL_DIR"
echo "═══════════════════════════════════════════════════════════════"

# 1. Docker
if ! command -v docker >/dev/null; then
  echo "[1/8] Installing Docker..."
  curl -fsSL https://get.docker.com | bash
fi

# 2. Directory
mkdir -p $INSTALL_DIR/{config,certs,uploads,backups,logs}
cd $INSTALL_DIR

# 3. Activate license (stub — would POST to license.agencybook.net/v1/activate)
echo "[3/8] Activating license (stub)..."
INSTANCE_ID="onprem-$(echo $DOMAIN | sed 's/\./-/g')"

# 4. Generate secrets
DB_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
REDIS_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
JWT_SECRET=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# 5. Fetch docker-compose.yml + .env template
echo "[5/8] Fetching configuration..."
curl -fsSL https://install.agencybook.net/configs/docker-compose.yml > docker-compose.yml || \
  echo "(template fetch failed — full Phase 14 install server not yet deployed)"

cat > .env <<ENVFILE
VERSION=latest
LICENSE_KEY=$LICENSE_KEY
INSTANCE_ID=$INSTANCE_ID
DB_PASS=$DB_PASS
REDIS_PASS=$REDIS_PASS
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
DOMAIN=$DOMAIN
ENVFILE
chmod 600 .env

# 6. SSL (Let's Encrypt via certbot in nginx container — stub)
echo "[6/8] SSL setup (stub)..."

# 7. docker compose up
# echo "[7/8] Starting AgencyOS..."
# docker compose pull && docker compose up -d

# 8. Health check
# echo "[8/8] Health check..."
# for i in {1..30}; do sleep 2; curl -fs https://$DOMAIN/api/health && break; done

echo ""
echo "Skeleton complete. Full Phase 14 (signed images, license server,"
echo "FRP tunnel) implements when first signed enterprise deal lands."
