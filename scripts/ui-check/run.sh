#!/usr/bin/env bash
# Prova end-to-end dell'interfaccia con l'agente demo, in un container usa e getta,
# usando il browserless del server (rete n8n_default). Uscita: screenshot + violazioni axe.
# Richiede: npm run build gia' fatto.  Uso: scripts/ui-check/run.sh [--dark]  (LANGCODE=de|en|cs|ru per un'altra lingua)
set -euo pipefail
cd "$(dirname "$0")/../.."
docker image inspect agicloud-uitest:latest >/dev/null 2>&1 || docker build -q -t agicloud-uitest:latest scripts/ui-check >/dev/null
docker rm -f agicloud-uitest >/dev/null 2>&1 || true
# Motore PII (container rizzo-pii sulla rete bridge predefinita): raggiunto per indirizzo, se c'e'
PII_IP=$(docker inspect rizzo-pii -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' 2>/dev/null || true)
docker run -d --rm --name agicloud-uitest --network n8n_default --user "$(id -u):$(id -g)" \
  -v "$PWD":/app:ro -w /app -e HOST=0.0.0.0 -e PORT=3095 -e AUTH_TOKEN=prova-locale-123 \
  -e AGICLOUD_DEMO_AGENT=1 ${PII_IP:+-e RIZZO_PII_URL=http://$PII_IP:5005} -e DATA_DIR=/tmp/data -e PROJECT_ROOTS=/tmp/proj -e HOME=/tmp \
  agicloud-uitest:latest sh -c 'mkdir -p /tmp/proj/demo /tmp/proj/capo && cd /tmp/proj/capo && git init -q && echo prova > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && cd /app && exec node --import tsx apps/server/src/index.ts' >/dev/null
trap 'docker rm -f agicloud-uitest >/dev/null 2>&1' EXIT
[ -n "$PII_IP" ] && docker network connect bridge agicloud-uitest
sleep 5
DARK=$([ "${1:-}" = "--dark" ] && echo 1 || echo 0) OUT=${OUT:-data/ui-check} node scripts/ui-check/check.mjs
