#!/usr/bin/env bash
# Rinnova il certificato wildcard *.agicloud.dev (lego + DNS Cloudflare) e lo copia dove lo legge Caddy.
# Lancialo come claude; dopo, root deve ricaricare Caddy (lo fa il cron installato da deploy-platform.sh caddy).
set -euo pipefail
cd /opt/agicloud
export CLOUDFLARE_DNS_API_TOKEN=$(python3 -c "import json;print(json.load(open('/home/user/agicloud/data/vault.json'))['CLOUDFLARE_API_KEY']['value'])")
CRT=lego/certificates/_.agicloud.dev.crt
if [ -s "$CRT" ] && openssl x509 -checkend $((30*86400)) -noout -in "$CRT" >/dev/null 2>&1 && [ "${1:-}" != "--force" ]; then echo "certificato valido ancora 30+ giorni"; exit 0; fi
docker run --rm -u "$(id -u):$(id -g)" -e CLOUDFLARE_DNS_API_TOKEN -e LEGO_PATH=/acme -e LEGO_EMAIL=admin@agicloud.dev -e LEGO_ACCEPT_TOS=true \
  -e LEGO_DNS=cloudflare -e LEGO_DNS_PROPAGATION_WAIT=30s -e 'LEGO_DOMAINS=*.agicloud.dev' -v /opt/agicloud/lego:/acme goacme/lego:latest renew --days 30 >/dev/null
install -m 644 lego/certificates/_.agicloud.dev.crt certs/wildcard.crt
install -m 644 lego/certificates/_.agicloud.dev.key certs/wildcard.key
echo "certificato aggiornato"
