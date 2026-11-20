# syntax=docker/dockerfile:1

FROM oven/bun:1-slim AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build && rm -rf node_modules && bun install --frozen-lockfile --production

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DISABLE_HMR=true \
    NEXA_DATA_DIR=/app/data \
    NEXA_DB_PATH=/app/data/nexa_genesis.sqlite3 \
    NEXA_PAID_FALLBACK_ALLOWED=false \
    NEXA_LIVE_TRADING_ENABLED=false \
    NEXA_EXTERNAL_COMMERCE_ENABLED=false

RUN mkdir -p /app/data/backups /app/data/exports /app/data/artifacts /app/workspace_projects \
    && chown -R node:node /app/data /app/workspace_projects \
    && chmod 750 /app/data /app/workspace_projects

COPY --from=builder --chown=root:root /app/package.json ./package.json
COPY --from=builder --chown=root:root /app/node_modules ./node_modules
COPY --from=builder --chown=root:root /app/dist ./dist
COPY --from=builder --chown=root:root /app/server.ts ./server.ts
COPY --from=builder --chown=root:root /app/server ./server
COPY --from=builder --chown=root:root /app/deploy/seed ./deploy/seed

RUN chmod -R a-w /app/package.json /app/node_modules /app/dist /app/server.ts /app/server /app/deploy/seed

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["npm", "start"]
