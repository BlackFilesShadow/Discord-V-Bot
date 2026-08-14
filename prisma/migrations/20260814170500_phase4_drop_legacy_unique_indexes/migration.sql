-- Phase 4 follow-up: some legacy Prisma baselines materialized guild-only
-- uniqueness as standalone indexes rather than table constraints. The main
-- scope migration drops constraints, but standalone indexes survive that.
-- Remove both representations before enforcing gameserver-scoped uniqueness.

ALTER TABLE "EconomyConfig"
  DROP CONSTRAINT IF EXISTS "EconomyConfig_guildId_key";
ALTER TABLE "EconomyAccount"
  DROP CONSTRAINT IF EXISTS "EconomyAccount_guildId_userDiscordId_key";
ALTER TABLE "BankInterestRun"
  DROP CONSTRAINT IF EXISTS "BankInterestRun_guildId_runDate_key";
ALTER TABLE "CasinoGame"
  DROP CONSTRAINT IF EXISTS "CasinoGame_guildId_type_key";

DROP INDEX IF EXISTS "EconomyConfig_guildId_key";
DROP INDEX IF EXISTS "EconomyAccount_guildId_userDiscordId_key";
DROP INDEX IF EXISTS "BankInterestRun_guildId_runDate_key";
DROP INDEX IF EXISTS "CasinoGame_guildId_type_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EconomyConfig_guildId_nitradoConnId_key"
  ON "EconomyConfig"("guildId", "nitradoConnId");
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyAccount_guildId_nitradoConnId_userDiscordId_key"
  ON "EconomyAccount"("guildId", "nitradoConnId", "userDiscordId");
CREATE UNIQUE INDEX IF NOT EXISTS "BankInterestRun_guildId_nitradoConnId_runDate_key"
  ON "BankInterestRun"("guildId", "nitradoConnId", "runDate");
CREATE UNIQUE INDEX IF NOT EXISTS "CasinoGame_guildId_nitradoConnId_type_key"
  ON "CasinoGame"("guildId", "nitradoConnId", "type");
