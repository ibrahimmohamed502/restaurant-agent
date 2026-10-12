# =============================================================================
# Stage 5 frontend — multi-stage production image (no host build artifacts).
# Build context = repository root (see docker-compose.yml → build.context: .)
# =============================================================================

# ---- deps (cached unless package files change) ----
FROM node:22-alpine AS deps
WORKDIR /repo
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --omit=dev=false --no-audit --no-fund

# ---- build ----
FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY apps/web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runtime (standalone output) ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /repo/.next/standalone ./
COPY --from=builder --chown=node:node /repo/.next/static ./.next/static
COPY --from=builder --chown=node:node /repo/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
