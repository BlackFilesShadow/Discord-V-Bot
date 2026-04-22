# =====================================================
# Discord-V-Bot — Multi-Stage Production Dockerfile
# =====================================================

# ----- Build-Stage -----
FROM node:20-alpine AS builder

WORKDIR /app

# OpenSSL wird von Prisma benötigt
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx prisma generate
RUN npm run build

# ----- Runtime-Stage -----
FROM node:20-alpine

WORKDIR /app

# OpenSSL für Prisma + wget für Healthcheck
RUN apk add --no-cache openssl wget

# Non-Root-User
RUN addgroup -S bot && adduser -S bot -G bot

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist/ ./dist/

# Verzeichnisse anlegen und Rechte setzen
RUN mkdir -p uploads logs && chown -R bot:bot /app

USER bot

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Migrationen anwenden, dann Bot starten
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
