# Ambiente AgiCloud di un utente (immagine usata dall'orchestratore):
#   docker build -f node/Dockerfile --build-arg UID=$(id -u) -t agicloud/node:latest .
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agicloud
COPY package.json package-lock.json tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/bridge/package.json packages/bridge/
COPY packages/design/package.json packages/design/
RUN npm ci --include=dev --no-audit --no-fund
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages
RUN npm run build -w @agicloud/web

FROM node:22-bookworm-slim
ARG UID=1001
# Strumenti per foto e video che gli agenti usano da shell: ffmpeg, caratteri, Pillow e MoviePy (in un ambiente a parte, /opt/video-tools)
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates openssh-client python3 python3-venv procps ffmpeg fonts-dejavu-core fonts-liberation && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/video-tools && /opt/video-tools/bin/pip install --no-cache-dir moviepy pillow \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code opencode-ai @openai/codex \
 && (userdel -r node 2>/dev/null; useradd -m -d /data/home -u ${UID} -s /bin/bash agicloud)
WORKDIR /opt/agicloud
COPY --from=build /opt/agicloud /opt/agicloud
# Tutto quello che l'utente scrive sta in /data (unico volume; il resto del filesystem e' in sola lettura)
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3095 TRUST_PROXY=1 DATA_DIR=/data/state HOME=/data/home \
    WORKSPACES_ROOT=/data/progetti PROJECT_ROOTS=/data/progetti:/data/home PATH=/data/home/.local/bin:/opt/video-tools/bin:/usr/local/bin:/usr/bin:/bin \
    IMAGEIO_FFMPEG_EXE=/usr/bin/ffmpeg TMPDIR=/data/tmp
USER agicloud
EXPOSE 3095
CMD ["sh", "-c", "mkdir -p /data/state /data/progetti /data/home /data/tmp && exec node --import tsx apps/server/src/index.ts"]
