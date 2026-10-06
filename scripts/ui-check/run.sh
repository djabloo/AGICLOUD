#!/usr/bin/env bash
# Prova end-to-end dell'interfaccia con l'agente demo, in un container usa e getta,
# usando il browserless del server (rete n8n_default). Uscita: screenshot + violazioni axe.
# Richiede: npm run build gia' fatto.  Uso: scripts/ui-check/run.sh [--dark]
set -euo pipefail
cd "$(dirname "$0")/../.."
docker rm -f agicloud-uitest >/dev/null 2>&1 || true
docker run -d --rm --name agicloud-uitest --network n8n_default --user "$(id -u):$(id -g)" \
  -v "$PWD":/app:ro -w /app -e HOST=0.0.0.0 -e PORT=3095 -e AUTH_TOKEN=prova-locale-123 \
  -e AGICLOUD_DEMO_AGENT=1 -e DATA_DIR=/tmp/data -e PROJECT_ROOTS=/tmp/proj -e HOME=/tmp \
  node:22-bookworm-slim sh -c 'mkdir -p /tmp/proj/demo && exec node --import tsx apps/server/src/index.ts' >/dev/null
trap 'docker rm -f agicloud-uitest >/dev/null 2>&1' EXIT
sleep 5
DARK=$([ "${1:-}" = "--dark" ] && echo 1 || echo 0) OUT=${OUT:-data/ui-check} node scripts/ui-check/check.mjs
