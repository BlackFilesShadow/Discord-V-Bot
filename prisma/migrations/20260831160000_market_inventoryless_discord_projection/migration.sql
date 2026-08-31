-- Schwarzmarkt-Angebote sind ab hier mengenunabhaengige Angebote. Die alte
-- stock-Spalte bleibt nur als abwaertskompatible Persistenzspalte bestehen und
-- darf von neuer Runtime/UI nicht mehr fuer Verfuegbarkeit verwendet werden.
ALTER TABLE "EconomyMarketListing" ALTER COLUMN "stock" SET DEFAULT 0;

CREATE TABLE "EconomyMarketDiscordProjection" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "catalogChannelId" TEXT,
  "catalogMessageId" TEXT,
  "directBuyEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "directBuyChannelId" TEXT,
  "directBuyMessageId" TEXT,
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
CREATE UNIQUE INDEX "EconomyMarketDiscordProjection_catalogMessageId_key"
  ON "EconomyMarketDiscordProjection"("catalogMessageId") WHERE "catalogMessageId" IS NOT NULL;
CREATE UNIQUE INDEX "EconomyMarketDiscordProjection_directBuyMessageId_key"
  ON "EconomyMarketDiscordProjection"("directBuyMessageId") WHERE "directBuyMessageId" IS NOT NULL;
CREATE INDEX "EconomyMarketDiscordProjection_scope_idx"
  ON "EconomyMarketDiscordProjection"("guildId", "nitradoConnId");
