#!/usr/bin/env bash
# Installazione di AgiCloud su una VPS Ubuntu 24.04 pulita (da root), per farne l'immagine "agicloud-node".
# La lancia node/build-image.ts sulla VPS temporanea, con /root/agicloud.tar.gz (codice + interfaccia gia' compilata).
# Alla fine pulisce la macchina perche' lo snapshot non porti con se' chiavi, log o identita'.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
log() { echo "==> $*"; }

# Qualche tentativo in piu': appena nata, la VPS puo' ancora avere apt occupato (cloud-init fa i suoi
# aggiornamenti in sottofondo) o un mirror che risponde male per un attimo.
apt_retry() {
  local n=1
  until apt-get "$@"; do
    if [ "$n" -ge 5 ]; then return 1; fi
    echo "    apt occupato o mirror lento, riprovo tra 10s (tentativo $n)..."
    n=$((n + 1))
    sleep 10
  done
}

log "Aspetto che cloud-init finisca (puo' ancora usare apt in sottofondo)"
cloud-init status --wait >/dev/null 2>&1 || true

log "Aggiornamenti di sistema"
apt_retry update -q
apt_retry upgrade -yq
apt_retry install -yq curl ca-certificates git gnupg ufw unattended-upgrades build-essential python3 \
  debian-keyring debian-archive-keyring apt-transport-https

log "Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt_retry install -yq nodejs

log "Caddy (https automatico)"
# Binario ufficiale invece del repository apt su Cloudsmith: il mirror pubblico e' a banda
# limitata e a volte risponde "402 Payment Required" (visto il 10/10/2026).
CADDY_ARCH=$(dpkg --print-architecture)
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o /usr/bin/caddy
chmod 755 /usr/bin/caddy
/usr/bin/caddy version
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy
usermod -d /var/lib/caddy caddy 2>/dev/null || true
install -d -o caddy -g caddy -m 755 /etc/caddy
install -d -o caddy -g caddy -m 750 /var/lib/caddy /var/log/caddy
[ -f /etc/caddy/Caddyfile ] || install -o caddy -g caddy -m 644 /dev/null /etc/caddy/Caddyfile
cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
WorkingDirectory=/var/lib/caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
CADDYUNIT
systemctl daemon-reload

log "Utente e cartelle"
id agicloud >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agicloud
install -d -o agicloud -g agicloud -m 750 /var/lib/agicloud /home/agicloud/progetti
install -d -o root -g root -m 755 /opt/agicloud /etc/agicloud
tar -xzf /root/agicloud.tar.gz -C /opt/agicloud
chown -R agicloud:agicloud /opt/agicloud

log "Dipendenze di AgiCloud"
sudo -u agicloud -H bash -lc 'cd /opt/agicloud && npm ci --no-audit --no-fund'

log "Agenti"
npm install -g --no-audit --no-fund opencode-ai
sudo -u agicloud -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
sudo -u agicloud -H bash -lc 'curl -fsS https://cursor.com/install | bash'
# Adattatore ACP di Claude Code: nella cache di npm, cosi' la prima chat non lo scarica
sudo -u agicloud -H bash -lc 'npm cache add @agentclientprotocol/claude-agent-acp@0.86.0 >/dev/null'
grep -q '.local/bin' /home/agicloud/.profile || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/agicloud/.profile

log "Servizi"
install -m 755 /opt/agicloud/node/firstboot.sh /usr/local/sbin/agicloud-firstboot
install -m 644 /opt/agicloud/node/agicloud.service /etc/systemd/system/agicloud.service
systemctl daemon-reload
systemctl enable agicloud.service caddy.service

log "Sicurezza"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl enable unattended-upgrades

log "Versioni"
node --version; caddy version | head -1; opencode --version 2>/dev/null | head -1 || true
sudo -u agicloud -H bash -lc 'claude --version; cursor-agent --version' 2>&1 | head -2 || true

log "Pulizia per lo snapshot"
rm -f /root/agicloud.tar.gz /root/install.sh
rm -f /root/.ssh/authorized_keys          # la chiave della VPS temporanea non resta nell'immagine
rm -f /var/lib/agicloud/auth-token /var/lib/agicloud/setup-token
rm -f /etc/ssh/ssh_host_*                  # rigenerate al primo avvio di ogni VPS
apt-get clean
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
rm -rf /var/log/*.gz /var/log/journal/* /tmp/* /home/agicloud/.npm/_logs
cloud-init clean --logs --seed
truncate -s 0 /etc/machine-id
log "Fatto"
