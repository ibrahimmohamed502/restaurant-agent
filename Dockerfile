# Restaurant Page AI Agent — production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first → better Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code, owned by the built-in non-root user
COPY --chown=node:node . .
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
