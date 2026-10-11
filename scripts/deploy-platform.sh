#!/usr/bin/env bash
# Messa online della piattaforma AgiCloud. Serve root solo per due cose: la cartella /opt/agicloud e il Caddyfile.
#   sudo bash scripts/deploy-platform.sh prepare   -> crea /opt/agicloud (poi il resto lo fa claude, senza root)
#   sudo bash scripts/deploy-platform.sh caddy     -> aggiorna Caddy (backup, controllo, ricarica; ripristino se fallisce)
# Rilanciabile: non duplica nulla.
set -euo pipefail

OWNER=claude
ROOT=/opt/agicloud
CADDYFILE=/etc/caddy/Caddyfile

[ "$(id -u)" = 0 ] || { echo "Lancialo con sudo"; exit 1; }

case "${1:-}" in
prepare)
  mkdir -p "$ROOT"/{data,runners,certs}
  chown -R "$OWNER:$OWNER" "$ROOT"
  chmod 750 "$ROOT"
  # Il container della piattaforma gira come utente "node" (uid 1000): gli serve scrivere in data
  chown 1000:1000 "$ROOT/data"
  # Caddy deve poter leggere il certificato wildcard
  chgrp caddy "$ROOT/certs" && chmod 750 "$ROOT/certs"
  chmod 751 "$ROOT"
  echo "✓ $ROOT pronta"
  ;;
caddy)
  [ -s "$ROOT/certs/wildcard.crt" ] && [ -s "$ROOT/certs/wildcard.key" ] || { echo "Manca il certificato wildcard in $ROOT/certs: non e' ancora stato emesso"; exit 1; }
  curl -fsS http://127.0.0.1:3110/api/health >/dev/null || { echo "La piattaforma non risponde su 127.0.0.1:3110: avviala prima"; exit 1; }
  curl -s -o /dev/null http://127.0.0.1:3112/ || { echo "Il proxy ambienti non risponde su 127.0.0.1:3112: avvia agicloud-edge"; exit 1; }
  # Rinnovo settimanale del certificato wildcard (lo emette claude, Caddy lo ricarica root)
  cat > /etc/cron.d/agicloud-cert <<CRON
17 4 * * 1 root sudo -u $OWNER /opt/agicloud/renew-cert.sh >> /var/log/agicloud-cert.log 2>&1 && systemctl reload caddy
CRON
  chmod 644 /etc/cron.d/agicloud-cert
  if grep -q "# piattaforma (privata)" "$CADDYFILE"; then echo "Caddyfile gia' aggiornato"; exit 0; fi
  BAK="$CADDYFILE.bak-$(date +%F-%H%M%S)"
  cp -p "$CADDYFILE" "$BAK"
  python3 - "$CADDYFILE" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
# Il vecchio blocco statico di agicloud.dev viene sostituito dalla piattaforma
s = re.sub(r'\nagicloud\.dev \{\n.*?\n\}\n', '\n', s, count=1, flags=re.S)
s += '''
# piattaforma (privata)
agicloud.dev {
    encode gzip zstd
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:3110
}

# Dashboard admin: dominio non indovinabile (le API admin rispondono solo qui)
admin-323cloud.agicloud.dev {
    encode gzip zstd
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:3110
}

# Ambienti utente: <nome>.agicloud.dev (app.agicloud.dev e www hanno un blocco proprio, piu' specifico)
*.agicloud.dev {
    tls /opt/agicloud/certs/wildcard.crt /opt/agicloud/certs/wildcard.key
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:3112
}
'''
open(p, 'w').write(s)
PY
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy && echo "✓ Caddy aggiornato (backup: $BAK)"
  else
    cp -p "$BAK" "$CADDYFILE"; echo "✗ Configurazione non valida: ripristinato il Caddyfile"; caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -5; exit 1
  fi
  ;;
*) echo "Uso: sudo bash $0 prepare|caddy"; exit 1 ;;
esac
