-- ServerSettings.economyActive ist ab jetzt die kanonische Aktivierung pro
-- Guild + Gameserver. Bestehende kompatible Economy-Konfigurationen werden
-- einmalig daran ausgerichtet, damit Scheduler/Legacy-Code nicht mit einem
-- abweichenden zweiten Aktivierungszustand weiterlaufen.

UPDATE "EconomyConfig" AS ec
SET "enabled" = ss."economyActive",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "ServerSettings" AS ss
WHERE ec."guildId" = ss."guildId"
  AND ec."nitradoConnId" = ss."nitradoConnId"
  AND ec."nitradoConnId" IS NOT NULL
  AND ec."enabled" IS DISTINCT FROM ss."economyActive";

UPDATE "EconomySlotConfig" AS esc
SET "enabled" = ss."economyActive",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "ServerSettings" AS ss
WHERE esc."guildId" = ss."guildId"
  AND esc."nitradoConnId" = ss."nitradoConnId"
  AND esc."enabled" IS DISTINCT FROM ss."economyActive";
