-- Phase 4 / ECO-S01..S05
-- Server-Scope fuer die komplette Wirtschaftsdaten-Wahrheit.
--
-- Sicherheitsprinzip fuer Legacy-Daten:
-- * exakt EIN nutzbarer aktiver Slot (1..4 + gebundene Server-ID) => bestehende
--   Economy wird diesem Slot zugeordnet;
-- * 0 oder >1 nutzbare Slots => NICHT raten, NICHT kopieren. Die Guild wird als
--   MIGRATION_REQUIRED markiert und die Legacy-Zeilen bleiben mit NULL-Scope
--   erhalten, bis der Owner einen Primaerserver auswaehlt.

CREATE TABLE IF NOT EXISTS "EconomyScopeMigration" (
  "guildId" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'MIGRATION_REQUIRED',
  "primaryNitradoConnId" TEXT,
  "detectedActiveServerCount" INTEGER NOT NULL DEFAULT 0,
  "resolvedByDiscordId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyScopeMigration_pkey" PRIMARY KEY ("guildId")
);
CREATE INDEX IF NOT EXISTS "EconomyScopeMigration_status_idx"
  ON "EconomyScopeMigration"("status");
CREATE INDEX IF NOT EXISTS "EconomyScopeMigration_primaryNitradoConnId_idx"
  ON "EconomyScopeMigration"("primaryNitradoConnId");

ALTER TABLE "EconomyConfig"      ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;
ALTER TABLE "BankInterestRun"    ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;
ALTER TABLE "EconomyAccount"     ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;
ALTER TABLE "EconomyTransaction" ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;
ALTER TABLE "CasinoGame"         ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;
ALTER TABLE "CasinoRound"        ADD COLUMN IF NOT EXISTS "nitradoConnId" TEXT;

-- Ledger/RewardRule waren bereits additiv nullable servergescopt. Auch deren
-- Legacy-NULL-Zeilen werden bei eindeutigem Ein-Server-Fall mitgezogen.

-- Alle Guilds, die irgendeine Legacy-Economy-Wahrheit besitzen, erfassen.
WITH economy_guilds AS (
  SELECT "guildId" FROM "EconomyConfig"
  UNION SELECT "guildId" FROM "EconomyAccount"
  UNION SELECT "guildId" FROM "EconomyTransaction"
  UNION SELECT "guildId" FROM "BankInterestRun"
  UNION SELECT "guildId" FROM "EconomyLedgerEntry"
  UNION SELECT "guildId" FROM "EconomyRewardRule"
  UNION SELECT "guildId" FROM "CasinoGame"
  UNION SELECT "guildId" FROM "CasinoRound"
), active_counts AS (
  SELECT g."guildId",
         COUNT(n."id")::INTEGER AS active_count,
         CASE WHEN COUNT(n."id") = 1 THEN MIN(n."id") ELSE NULL END AS only_conn
    FROM economy_guilds g
    LEFT JOIN "NitradoConnection" n
      ON n."guildId" = g."guildId"
     AND n."status" = 'ACTIVE'
     AND n."slot" BETWEEN 1 AND 4
     AND n."nitradoServerId" IS NOT NULL
   GROUP BY g."guildId"
)
INSERT INTO "EconomyScopeMigration" (
  "guildId", "status", "primaryNitradoConnId", "detectedActiveServerCount",
  "resolvedAt", "createdAt", "updatedAt"
)
SELECT "guildId",
       CASE WHEN active_count = 1 THEN 'RESOLVED' ELSE 'MIGRATION_REQUIRED' END,
       only_conn,
       active_count,
       CASE WHEN active_count = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM active_counts
ON CONFLICT ("guildId") DO UPDATE SET
  "status" = EXCLUDED."status",
  "primaryNitradoConnId" = EXCLUDED."primaryNitradoConnId",
  "detectedActiveServerCount" = EXCLUDED."detectedActiveServerCount",
  "resolvedAt" = EXCLUDED."resolvedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

-- Nur eindeutig aufloesbare Guilds backfuellen. Kein INSERT/COPY von Geld.
UPDATE "EconomyConfig" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "BankInterestRun" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "EconomyAccount" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "EconomyTransaction" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "EconomyLedgerEntry" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "EconomyRewardRule" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

UPDATE "CasinoGame" e
   SET "nitradoConnId" = m."primaryNitradoConnId"
  FROM "EconomyScopeMigration" m
 WHERE e."guildId" = m."guildId"
   AND e."nitradoConnId" IS NULL
   AND m."status" = 'RESOLVED'
   AND m."primaryNitradoConnId" IS NOT NULL;

-- CasinoRound folgt bevorzugt dem bereits aufgeloesten Game-Scope.
UPDATE "CasinoRound" r
   SET "nitradoConnId" = g."nitradoConnId"
  FROM "CasinoGame" g
 WHERE r."gameId" = g."id"
   AND r."nitradoConnId" IS NULL
   AND g."nitradoConnId" IS NOT NULL;

-- Alte guildweite Unique-Keys verhindern echte Mehrserver-Konten/-Configs.
ALTER TABLE "EconomyConfig"   DROP CONSTRAINT IF EXISTS "EconomyConfig_guildId_key";
ALTER TABLE "EconomyAccount"  DROP CONSTRAINT IF EXISTS "EconomyAccount_guildId_userDiscordId_key";
ALTER TABLE "BankInterestRun" DROP CONSTRAINT IF EXISTS "BankInterestRun_guildId_runDate_key";
ALTER TABLE "CasinoGame"      DROP CONSTRAINT IF EXISTS "CasinoGame_guildId_type_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EconomyConfig_guildId_nitradoConnId_key"
  ON "EconomyConfig"("guildId", "nitradoConnId");
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyAccount_guildId_nitradoConnId_userDiscordId_key"
  ON "EconomyAccount"("guildId", "nitradoConnId", "userDiscordId");
CREATE UNIQUE INDEX IF NOT EXISTS "BankInterestRun_guildId_nitradoConnId_runDate_key"
  ON "BankInterestRun"("guildId", "nitradoConnId", "runDate");
CREATE UNIQUE INDEX IF NOT EXISTS "CasinoGame_guildId_nitradoConnId_type_key"
  ON "CasinoGame"("guildId", "nitradoConnId", "type");

-- Solange eine Guild MIGRATION_REQUIRED ist, existiert hoechstens eine
-- Legacy-NULL-Wahrheit pro altem Schluessel. Diese Partial-Indexes verhindern,
-- dass ein Bug versehentlich weitere ungescopte Legacy-Zeilen erzeugt.
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyConfig_legacy_guild_key"
  ON "EconomyConfig"("guildId") WHERE "nitradoConnId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyAccount_legacy_guild_user_key"
  ON "EconomyAccount"("guildId", "userDiscordId") WHERE "nitradoConnId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "BankInterestRun_legacy_guild_date_key"
  ON "BankInterestRun"("guildId", "runDate") WHERE "nitradoConnId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "CasinoGame_legacy_guild_type_key"
  ON "CasinoGame"("guildId", "type") WHERE "nitradoConnId" IS NULL;

CREATE INDEX IF NOT EXISTS "EconomyConfig_guildId_nitradoConnId_idx"
  ON "EconomyConfig"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "EconomyAccount_guildId_nitradoConnId_idx"
  ON "EconomyAccount"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "EconomyTx_guild_conn_user_created_idx"
  ON "EconomyTransaction"("guildId", "nitradoConnId", "userDiscordId", "createdAt");
CREATE INDEX IF NOT EXISTS "BankInterestRun_guildId_nitradoConnId_idx"
  ON "BankInterestRun"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "CasinoGame_guildId_nitradoConnId_idx"
  ON "CasinoGame"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "CasinoRound_guildId_nitradoConnId_userDiscordId_createdAt_idx"
  ON "CasinoRound"("guildId", "nitradoConnId", "userDiscordId", "createdAt");

ALTER TABLE "EconomyScopeMigration"
  DROP CONSTRAINT IF EXISTS "EconomyScopeMigration_status_check";
ALTER TABLE "EconomyScopeMigration"
  ADD CONSTRAINT "EconomyScopeMigration_status_check"
  CHECK ("status" IN ('MIGRATION_REQUIRED', 'RESOLVED'));
