-- Phase 7 KEEP: `NitradoConnection.keepOnlineEnabled` is the canonical source.
-- Preserve installations that previously enabled the legacy
-- `ServerSettings.permaOnly` toggle. This is idempotent and only turns the
-- canonical flag on; it never disables an already-enabled connection.
UPDATE "NitradoConnection" AS nc
SET "keepOnlineEnabled" = TRUE
FROM "ServerSettings" AS ss
WHERE ss."nitradoConnId" = nc."id"
  AND ss."guildId" = nc."guildId"
  AND ss."permaOnly" = TRUE
  AND nc."keepOnlineEnabled" = FALSE;
