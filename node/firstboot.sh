#!/usr/bin/env bash
# Primo avvio di una VPS nata dall'immagine agicloud-node (lanciato dal user_data di Hetzner).
#   agicloud-firstboot <dominio o vuoto> <codice di attivazione>
# Senza dominio si usa <ip-con-trattini>.sslip.io (https funziona anche cosi').
set -euo pipefail
DOMAIN="${1:-}"
SETUP="${2:-}"
if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS --max-time 5 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || hostname -I | awk '{print $1}')
  DOMAIN="${IP//./-}.sslip.io"
fi
# Codice di attivazione monouso (finche' non esiste ancora un token)
if [ -n "$SETUP" ] && [ ! -s /var/lib/agicloud/auth-token ]; then
  umask 077
  printf '%s\n' "$SETUP" > /var/lib/agicloud/setup-token
  chown agicloud:agicloud /var/lib/agicloud/setup-token
fi
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3095
}
CADDY
printf 'DOMAIN=%s\n' "$DOMAIN" > /etc/agicloud/node.env
usermod -d /var/lib/caddy caddy 2>/dev/null || true
install -d -o caddy -g caddy -m 750 /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy 2>/dev/null || true
systemctl restart agicloud.service
systemctl reload caddy.service || systemctl restart caddy.service
echo "AgiCloud pronto su https://$DOMAIN"
