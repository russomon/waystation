# Waystation gateway — the control plane: presigned URLs, the B2 event
# webhook, SSE progress, metering. Never touches file bytes; near-zero CPU.
# Built from the repo root (workspaces):
#   docker build -f gateway/Dockerfile -t waystation-gateway .
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY gateway/package.json gateway/
RUN npm ci -w gateway

COPY gateway/ gateway/
WORKDIR /app/gateway

ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["npx", "tsx", "src/server.ts"]
