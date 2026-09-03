-- Align the persisted market message shape with the Prisma model and runtime.
-- Existing legacy CATALOG/DIRECT_BUY/ORDER_BUTTON rows remain valid with NULL.
ALTER TABLE "EconomyMarketDiscordMessage"
  ADD COLUMN IF NOT EXISTS "vendorAccountId" TEXT;

DROP INDEX IF EXISTS "EconomyMarketDiscordMessage_projectionId_kind_pageIndex_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EconomyMarketDiscordMessage_projectionId_kind_vendorAccountId_pageIndex_key"
  ON "EconomyMarketDiscordMessage"("projectionId", "kind", "vendorAccountId", "pageIndex");

CREATE INDEX IF NOT EXISTS "EconomyMarketDiscordMessage_vendor_idx"
  ON "EconomyMarketDiscordMessage"("guildId", "nitradoConnId", "vendorAccountId");
