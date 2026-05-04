-- Faction system: decouple from Nitrado (Discord-only).
ALTER TABLE "Faction" ALTER COLUMN "nitradoConnId" DROP NOT NULL;
ALTER TABLE "FactionSystemConfig" ALTER COLUMN "nitradoConnId" DROP NOT NULL;

-- Drop old per-slot uniques (allows nullable + collapse to per-guild).
ALTER TABLE "Faction" DROP CONSTRAINT IF EXISTS "Faction_guildId_nitradoConnId_name_key";
ALTER TABLE "FactionSystemConfig" DROP CONSTRAINT IF EXISTS "FactionSystemConfig_guildId_nitradoConnId_key";

-- Collapse FactionSystemConfig to one config per guild.
-- If duplicates exist (multiple slots), keep the oldest and delete the rest.
DELETE FROM "FactionSystemConfig" a
USING "FactionSystemConfig" b
WHERE a."guildId" = b."guildId" AND a."createdAt" > b."createdAt";

-- New uniques (Discord-only scope).
CREATE UNIQUE INDEX IF NOT EXISTS "Faction_guildId_name_key" ON "Faction" ("guildId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "FactionSystemConfig_guildId_key" ON "FactionSystemConfig" ("guildId");

-- Performance: lookups per (guild, slot) for legacy displays.
CREATE INDEX IF NOT EXISTS "Faction_guildId_nitradoConnId_idx" ON "Faction" ("guildId", "nitradoConnId");
