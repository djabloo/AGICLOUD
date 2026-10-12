#!/usr/bin/env bash
# login            -> schermo virtuale + noVNC su 6080 + "gflow auth login" (al massimo 15 minuti)
# qualsiasi altro  -> schermo virtuale + gflow <argomenti>
set -e
mkdir -p "$HOME"
# Un container interrotto lascia il blocco del profilo (Singleton*): AgiCloud avvia un solo container Flow alla volta, quindi e' sicuro toglierlo
rm -f /data/gflow/profile_*/Singleton* 2>/dev/null || true
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 1 20); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.25; done

if [ "$1" = "login" ]; then
  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 -q >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/dev/null 2>&1 &
  export GFLOW_LOGIN_WINDOW=1 GFLOW_LOGIN_SIZE=1900,1030
  P=/data/gflow/profile_default
  rm -f /data/gflow/login.done
  # Fase 1: Chromium normale, senza automazione, finche' l'utente ha finito di accedere a Google e a Flow.
  # (gflow da solo chiude il browser appena Google risulta collegato, prima che l'app Flow sia pronta, e la verifica fallisce.)
  /usr/bin/chromium --user-data-dir="$P" --no-first-run --no-default-browser-check --password-store=basic "https://labs.google/fx/tools/flow?hl=en" >/dev/null 2>&1 &
  CH=$!
  for _ in $(seq 1 900); do
    kill -0 "$CH" 2>/dev/null || break
    if [ -e /data/gflow/login.done ]; then
      kill -TERM "$CH" 2>/dev/null   # chiusura ordinata: Chromium scrive i cookie su disco
      for _ in $(seq 1 30); do kill -0 "$CH" 2>/dev/null || break; sleep 0.5; done
      break
    fi
    sleep 1
  done
  kill -0 "$CH" 2>/dev/null && { kill -TERM "$CH"; sleep 3; }
  # Si aspetta che sia sparito ogni processo di Chromium e si toglie il blocco del profilo, altrimenti il browser della fase 2 esce subito
  for _ in $(seq 1 40); do pgrep -f /usr/lib/chromium/chromium >/dev/null || break; sleep 0.5; done
  rm -f "$P"/Singleton* /data/gflow/login.done
  # Fase 2: gflow riapre il profilo (si vede un attimo nella finestra), controlla la sessione e scrive il marcatore dell'account.
  # L'uscita resta in un file: il container sparisce a fine accesso e senza questo non si saprebbe com'e' andata.
  set +e
  echo "Verifica della sessione Flow..." | tee /data/gflow/login.log
  timeout 300 gflow auth login --browser chrome 2>&1 | tee -a /data/gflow/login.log
  exit "${PIPESTATUS[0]}"
fi
exec gflow "$@"
