# Piattaforma AgiCloud: immagine minima (build dalla radice della repo: docker build -f apps/platform/Dockerfile .)
FROM node:22-slim
WORKDIR /app
RUN npm init -y >/dev/null && npm pkg set type=module && npm install --omit=dev --no-audit --no-fund hono@^4.13.13 @hono/node-server@^2.1.3 tsx@^4.23.15
COPY apps/platform/src ./src
COPY apps/platform/public ./public
ENV NODE_ENV=production PLATFORM_DATA_DIR=/data PLATFORM_PORT=3110
# Dentro il container serve ascoltare su tutte le interfacce; l'esposizione sull'host e' solo 127.0.0.1 (vedi docker-compose.yml)
ENV PLATFORM_HOST=0.0.0.0
USER node
EXPOSE 3110
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3110/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
