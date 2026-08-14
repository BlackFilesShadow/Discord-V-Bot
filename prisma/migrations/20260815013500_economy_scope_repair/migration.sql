-- Reconcile Legacy-Economy-Scope after the Phase-4 migration.
--
-- Never guess:
-- * already RESOLVED -> reuse the stored primary server;
-- * MIGRATION_REQUIRED + exactly one currently active/bound slot 1..5 -> this is
--   deterministic and may be auto-resolved;
-- * zero or multiple candidates -> remain MIGRATION_REQUIRED for owner choice.

WITH economy_guilds AS (
  SELECT "guildId" FROM "EconomyConfig" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "EconomyAccount" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "EconomyTransaction" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "BankInterestRun" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "EconomyLedgerEntry" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "EconomyRewardRule" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "CasinoGame" WHERE "nitradoConnId" IS NULL
  UNION SELECT "guildId" FROM "CasinoRound" WHERE "nitradoConnId" IS NULL
), active_counts AS (
  SELECT g."guildId",
         COUNT(n."id")::INTEGER AS active_count,
         CASE WHEN COUNT(n."id") = 1 THEN MIN(n."id") ELSE NULL END AS only_conn
    FROM economy_guilds g
    LEFT JOIN "NitradoConnection" n
      ON n."guildId" = g."guildId"
     AND n."status" = 'ACTIVE'
     AND n."slot" BETWEEN 1 AND 5
     AND n."nitradoServerId" IS NOT NULL
   GROUP BY g."guildId"
)
INSERT INTO "EconomyScopeMigration" (
  "guildId", "status", "primaryNitradoConnId", "detectedActiveServerCount",
  "resolvedByDiscordId", "resolvedAt", "createdAt", "updatedAt"
)
SELECT "guildId",
       CASE WHEN active_count = 1 THEN 'RESOLVED' ELSE 'MIGRATION_REQUIRED' END,
       only_conn,
       active_count,
       CASE WHEN active_count = 1 THEN 'SYSTEM_AUTO_UNAMBIGUOUS' ELSE NULL END,
       CASE WHEN active_count = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM active_counts
ON CONFLICT ("guildId") DO UPDATE SET
  "status" = CASE
    WHEN "EconomyScopeMigration"."status" = 'RESOLVED' THEN 'RESOLVED'
    WHEN EXCLUDED."detectedActiveServerCount" = 1 THEN 'RESOLVED'
    ELSE 'MIGRATION_REQUIRED'
  END,
  "primaryNitradoConnId" = CASE
    WHEN "EconomyScopeMigration"."status" = 'RESOLVED' THEN "EconomyScopeMigration"."primaryNitradoConnId"
    WHEN EXCLUDED."detectedActiveServerCount" = 1 THEN EXCLUDED."primaryNitradoConnId"
    ELSE NULL
  END,
  "detectedActiveServerCount" = EXCLUDED."detectedActiveServerCount",
  "resolvedByDiscordId" = CASE
    WHEN "EconomyScopeMigration"."status" = 'RESOLVED' THEN "EconomyScopeMigration"."resolvedByDiscordId"
    WHEN EXCLUDED."detectedActiveServerCount" = 1 THEN 'SYSTEM_AUTO_UNAMBIGUOUS'
    ELSE NULL
  END,
  "resolvedAt" = CASE
    WHEN "EconomyScopeMigration"."status" = 'RESOLVED' THEN "EconomyScopeMigration"."resolvedAt"
    WHEN EXCLUDED."detectedActiveServerCount" = 1 THEN CURRENT_TIMESTAMP
    ELSE NULL
  END,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Backfill every remaining NULL-scope from the canonical resolved target.
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

UPDATE "CasinoRound" r
   SET "nitradoConnId" = g."nitradoConnId"
  FROM "CasinoGame" g
 WHERE r."gameId" = g."id"
   AND r."nitradoConnId" IS NULL
   AND g."nitradoConnId" IS NOT NULL;
