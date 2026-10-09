# Immagine per la prova dell'interfaccia: Node 22 (setsid, usato dai terminali, e' gia' in util-linux),
# git (copie separate dei thread affidati dal capo) e un finto `claude` per provare il login guidato
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY fake-bin/claude /usr/local/bin/claude
