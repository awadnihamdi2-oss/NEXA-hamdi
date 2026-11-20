#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Turnkey persistent production deploy script for any Linux VPS / GCE VM with Docker + Docker Compose v2.
# Preserves existing .env.production and Docker persistent volumes across re-deploys.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.production"
DOMAIN="${NEXA_DOMAIN:-:80}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is required on the target server." >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "Generating ${ENV_FILE} with cryptographically random secrets (mode 0600)..."
  SESSION_SECRET="$(openssl rand -hex 32)"
  SCHEDULER_TOKEN="$(openssl rand -hex 24)"
  ADMIN_PASS="${NEXA_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 18)}"
  APP_PROTO="http"
  if [ "${DOMAIN}" != ":80" ] && [[ "${DOMAIN}" != http://* ]]; then
    APP_PROTO="https"
  fi
  CLEAN_HOST="${DOMAIN#http://}"
  CLEAN_HOST="${CLEAN_HOST#https://}"
  [ "${CLEAN_HOST}" = ":80" ] && CLEAN_HOST="localhost"

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
PORT=3000
DISABLE_HMR=true
NEXA_DATA_DIR=/app/data
NEXA_DB_PATH=/app/data/nexa_genesis.sqlite3
NEXA_PAID_FALLBACK_ALLOWED=false
NEXA_LIVE_TRADING_ENABLED=false
NEXA_EXTERNAL_COMMERCE_ENABLED=false
NEXA_SESSION_SECRET=${SESSION_SECRET}
NEXA_SCHEDULER_TOKEN=${SCHEDULER_TOKEN}
NEXA_ADMIN_PASSWORD=${ADMIN_PASS}
APP_URL=${APP_PROTO}://${CLEAN_HOST}
# Add optional AI provider keys below:
# GEMINI_API_KEY=
# OPENROUTER_API_KEY=
# GROQ_API_KEY=
EOF
  chmod 600 "${ENV_FILE}"
  echo "Created ${ENV_FILE}. Sign in as username 'admin' with your configured NEXA_ADMIN_PASSWORD."
else
  echo "Using existing ${ENV_FILE} (preserved cleanly)."
fi

echo "Building and starting NEXA production containers..."
NEXA_DOMAIN="${DOMAIN}" docker compose -f "${ROOT_DIR}/deploy/compose.yaml" up -d --build

echo "Waiting for /api/health..."
for i in $(seq 1 20); do
  if docker exec nexa-quant-prod node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    echo "NEXA production container is healthy!"
    docker exec nexa-quant-prod npm run preflight
    exit 0
  fi
  sleep 2
done

echo "Error: NEXA container failed health check within timeout." >&2
docker logs --tail 50 nexa-quant-prod >&2 || true
exit 1
