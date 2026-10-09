# Stage 5.0 — Next.js frontend container (standalone output).
# Build locally (npm run build) and copy .next/standalone + .next/static + public.

FROM node:20-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY standalone/ ./
COPY static/ .next/static
COPY public/ public

EXPOSE 3000
CMD ["node", "server.js"]
