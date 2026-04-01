FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN addgroup -S bot && adduser -S bot -G bot

COPY package*.json ./
COPY prisma/ ./prisma/

RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist/ ./dist/

RUN mkdir -p uploads logs && chown -R bot:bot /app

USER bot

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
