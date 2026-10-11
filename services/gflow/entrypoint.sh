#!/usr/bin/env bash
# login            -> schermo virtuale + noVNC su 6080 + "gflow auth login" (al massimo 15 minuti)
# qualsiasi altro  -> schermo virtuale + gflow <argomenti>
set -e
mkdir -p "$HOME"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 1 20); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.25; done

if [ "$1" = "login" ]; then
  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 -q >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &
  exec timeout 900 gflow auth login --browser chrome
fi
exec gflow "$@"
