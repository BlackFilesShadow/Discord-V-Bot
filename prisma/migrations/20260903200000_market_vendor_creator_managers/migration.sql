-- Bestehende Schwarzmarkt-Haendler waren vor dem Management-Embed ohne
-- Manager-Zuordnung angelegt. Der Ersteller erhaelt deshalb idempotent den
-- selben Zugriff, den neue Haendler beim Anlegen erhalten.
INSERT INTO "EconomyVirtualAccountManager" (
  "id",
  "accountId",
  "guildId",
  "nitradoConnId",
  "userDiscordId",
  "addedByDiscordId",
  "createdAt"
)
SELECT
  md5(a."id" || ':market-vendor-creator-manager'),
  a."id",
  a."guildId",
  a."nitradoConnId",
  a."createdByDiscordId",
  a."createdByDiscordId",
  CURRENT_TIMESTAMP
FROM "EconomyVirtualAccount" a
WHERE a."kind" = 'MARKET_VENDOR'::"EconomyVirtualAccountKind"
  AND a."createdByDiscordId" ~ '^[0-9]{17,20}$'
ON CONFLICT ("accountId", "userDiscordId") DO NOTHING;
