# Motore del plugin Flow: gflow-cli (Google Flow: video Veo, immagini Imagen/Nano) con Chromium e uno schermo virtuale.
# gflow ha bisogno di un Chrome "con schermo" (reCAPTCHA rifiuta quello headless): qui gira sotto Xvfb; per il primo accesso
# di Google si apre una sessione noVNC che AgiCloud inoltra al browser dell'utente.
#   docker build -t agicloud-gflow:latest services/gflow
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth x11vnc novnc websockify ca-certificates curl procps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && mv /usr/bin/chromium /usr/bin/chromium.real \
 && printf '#!/bin/sh\nexec /usr/bin/chromium.real --no-sandbox --disable-dev-shm-usage --disable-gpu --window-size=1280,780 "$@"\n' > /usr/bin/chromium \
 && chmod +x /usr/bin/chromium
ARG GFLOW_VERSION=0.83.2
RUN pip install --no-cache-dir gflow-cli==${GFLOW_VERSION}
# Sessione e profili in /data/gflow (volume): login e cookie restano dopo ogni esecuzione
ENV PYTHONUNBUFFERED=1 GFLOW_CLI_UPDATE_CHECK=false GFLOW_CLI_HOME=/data/gflow HOME=/data/gflow/home DISPLAY=:99
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /data
ENTRYPOINT ["/app/entrypoint.sh"]
