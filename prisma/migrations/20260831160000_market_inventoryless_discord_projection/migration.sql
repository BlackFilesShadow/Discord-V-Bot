-- Schwarzmarkt-Angebote sind ab hier mengenunabhaengige Angebote. Die alte
-- stock-Spalte bleibt nur als abwaertskompatible Persistenzspalte bestehen und
-- darf von neuer Runtime/UI nicht mehr fuer Verfuegbarkeit verwendet werden.
ALTER TABLE "EconomyMarketListing" ALTER COLUMN "stock" SET DEFAULT 0;

CREATE TABLE "EconomyMarketDiscordProjection" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "catalogChannelId" TEXT,
  "directBuyEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "directBuyChannelId" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncError" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyMarketDiscordProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketDiscordProjection_catalog_channel_check"
    CHECK ("catalogChannelId" IS NULL OR "catalogChannelId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketDiscordProjection_direct_channel_check"
    CHECK ("directBuyChannelId" IS NULL OR "directBuyChannelId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketDiscordProjection_direct_channel_required_check"
    CHECK (NOT "directBuyEnabled" OR "directBuyChannelId" IS NOT NULL)
);

CREATE UNIQUE INDEX "EconomyMarketDiscordProjection_scope_key"
  ON "EconomyMarketDiscordProjection"("guildId", "nitradoConnId");
CREATE INDEX "EconomyMarketDiscordProjection_scope_idx"
  ON "EconomyMarketDiscordProjection"("guildId", "nitradoConnId");

CREATE TABLE "EconomyMarketDiscordMessage" (
  "id" TEXT NOT NULL,
  "projectionId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "pageIndex" INTEGER,
  "listingId" TEXT,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyMarketDiscordMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketDiscordMessage_projection_fkey"
    FOREIGN KEY ("projectionId") REFERENCES "EconomyMarketDiscordProjection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EconomyMarketDiscordMessage_kind_check"
    CHECK ("kind" IN ('CATALOG','DIRECT_BUY')),
  CONSTRAINT "EconomyMarketDiscordMessage_channel_check"
    CHECK ("channelId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketDiscordMessage_message_check"
    CHECK ("messageId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketDiscordMessage_shape_check"
    CHECK (
      ("kind"='CATALOG' AND "pageIndex" IS NOT NULL AND "listingId" IS NULL)
      OR ("kind"='DIRECT_BUY' AND "pageIndex" IS NULL AND "listingId" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "EconomyMarketDiscordMessage_message_key"
  ON "EconomyMarketDiscordMessage"("messageId");
-- PostgreSQL erlaubt bei UNIQUE mehrere NULL-Werte. Diese beiden vollstaendigen
-- Unique-Indizes entsprechen damit direkt den Prisma-@@unique-Deklarationen;
-- die Shape-Constraint stellt sicher, dass jeweils genau der fachlich relevante
-- Schluessel belegt ist.
CREATE UNIQUE INDEX "EconomyMarketDiscordMessage_projectionId_kind_pageIndex_key"
  ON "EconomyMarketDiscordMessage"("projectionId", "kind", "pageIndex");
CREATE UNIQUE INDEX "EconomyMarketDiscordMessage_projectionId_kind_listingId_key"
  ON "EconomyMarketDiscordMessage"("projectionId", "kind", "listingId");
CREATE INDEX "EconomyMarketDiscordMessage_scope_kind_idx"
  ON "EconomyMarketDiscordMessage"("guildId", "nitradoConnId", "kind");
CREATE INDEX "EconomyMarketDiscordMessage_listing_idx"
  ON "EconomyMarketDiscordMessage"("listingId");
