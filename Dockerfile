# =====================================================
# Discord-V-Bot — Multi-Stage Production Dockerfile
# Bot + Dashboard-UI im selben Image.
# =====================================================

# ----- UI-Build-Stage (Vite -> statisches Frontend) -----
FROM node:20-alpine AS ui-builder

WORKDIR /ui

COPY dashboard-ui/package*.json ./
RUN npm ci --no-audit --no-fund

COPY dashboard-ui/ ./
# vite.config.ts schreibt nach ../src/dashboard/public — das Verzeichnis
# muss zur Build-Zeit existieren (sonst weicht Vite auf cwd aus).
RUN mkdir -p /src/dashboard/public
RUN npm run build

# ----- Server-Build-Stage (TypeScript -> dist) -----
FROM node:20-alpine AS server-builder

WORKDIR /app

# OpenSSL wird von Prisma benoetigt
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci --no-audit --no-fund --ignore-scripts \
 && npx prisma generate

COPY tsconfig.json ./
COPY src/ ./src/

# UI-Output uebernehmen, damit der Server-Build den Asset-Ordner kennt.
# (express.static liest ihn zur Laufzeit aus dist/dashboard/public.)
COPY --from=ui-builder /src/dashboard/public/ ./src/dashboard/public/

# Nur tsc — npm run build wuerde rekursiv UI bauen wollen.
RUN npm run build:server

# ----- Runtime-Stage -----
FROM node:20-alpine

WORKDIR /app

# OpenSSL fuer Prisma + wget fuer Healthcheck
RUN apk add --no-cache openssl wget

# Non-Root-User
RUN addgroup -S bot && adduser -S bot -G bot

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && npx prisma generate

COPY --from=server-builder /app/dist/ ./dist/
# UI-Assets ins Runtime-Image (gleicher Pfad-Stub wie zur Build-Zeit,
# damit server.ts via path.resolve(__dirname, 'public') findet).
COPY --from=ui-builder /src/dashboard/public/ ./dist/src/dashboard/public/

# Verzeichnisse anlegen und Rechte setzen
RUN mkdir -p uploads logs && chown -R bot:bot /app

USER bot

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Migrationen anwenden, dann Bot starten
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
