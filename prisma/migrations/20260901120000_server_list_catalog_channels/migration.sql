ALTER TABLE "ServerSettings"
  ADD COLUMN IF NOT EXISTS "whitelistCatalogChannelId" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "whitelistCatalogMessageId" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "banCatalogChannelId" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "banCatalogMessageId" VARCHAR(20);

ALTER TABLE "ServerSettings"
  DROP CONSTRAINT IF EXISTS "ServerSettings_whitelistCatalogChannelId_format";
ALTER TABLE "ServerSettings"
  ADD CONSTRAINT "ServerSettings_whitelistCatalogChannelId_format"
  CHECK ("whitelistCatalogChannelId" IS NULL OR "whitelistCatalogChannelId" ~ '^[0-9]{17,20}$');

ALTER TABLE "ServerSettings"
  DROP CONSTRAINT IF EXISTS "ServerSettings_banCatalogChannelId_format";
ALTER TABLE "ServerSettings"
  ADD CONSTRAINT "ServerSettings_banCatalogChannelId_format"
  CHECK ("banCatalogChannelId" IS NULL OR "banCatalogChannelId" ~ '^[0-9]{17,20}$');