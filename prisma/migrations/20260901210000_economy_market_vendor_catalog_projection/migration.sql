-- Phase 2: feste, händlerspezifische Schwarzmarkt-Kataloge.
--
-- Bestehende EconomyMarketDiscordMessage-Zeilen (CATALOG, ORDER_BUTTON,
-- DIRECT_BUY) werden nicht migriert oder gelöscht. Die Runtime erzeugt zuerst
-- die neuen Vendor-Projektionen und entfernt Legacy-CATALOG/ORDER_BUTTON erst
-- nach einem vollständig erfolgreichen Sync.

CREATE UNIQUE INDEX "EconomyMarketDiscordProjection_id_scope_key"
  ON "EconomyMarketDiscordProjection"("id", "guildId", "nitradoConnId");

CREATE TABLE "EconomyMarketVendorCatalogProjection" (
  "id" TEXT NOT NULL,
  "projectionId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "vendorAccountId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "catalogMessageId" TEXT NOT NULL,
  "orderButtonMessageId" TEXT,
  "currentPage" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyMarketVendorCatalogProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketVendorCatalogProjection_projection_scope_fkey"
    FOREIGN KEY ("projectionId", "guildId", "nitradoConnId")
    REFERENCES "EconomyMarketDiscordProjection"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EconomyMarketVendorCatalogProjection_vendor_scope_fkey"
    FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")
    REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EconomyMarketVendorCatalogProjection_channel_check"
    CHECK ("channelId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketVendorCatalogProjection_catalog_message_check"
    CHECK ("catalogMessageId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketVendorCatalogProjection_order_message_check"
    CHECK ("orderButtonMessageId" IS NULL OR "orderButtonMessageId" ~ '^[0-9]{17,20}$'),
  CONSTRAINT "EconomyMarketVendorCatalogProjection_page_check"
    CHECK ("currentPage" >= 0)
);

CREATE UNIQUE INDEX "EconomyMarketVendorCatalogProjection_projection_vendor_key"
  ON "EconomyMarketVendorCatalogProjection"("projectionId", "vendorAccountId");
CREATE UNIQUE INDEX "EconomyMarketVendorCatalogProjection_catalog_message_key"
  ON "EconomyMarketVendorCatalogProjection"("catalogMessageId");
CREATE UNIQUE INDEX "EconomyMarketVendorCatalogProjection_order_message_key"
  ON "EconomyMarketVendorCatalogProjection"("orderButtonMessageId")
  WHERE "orderButtonMessageId" IS NOT NULL;
CREATE INDEX "EconomyMarketVendorCatalogProjection_scope_vendor_idx"
  ON "EconomyMarketVendorCatalogProjection"("guildId", "nitradoConnId", "vendorAccountId");
