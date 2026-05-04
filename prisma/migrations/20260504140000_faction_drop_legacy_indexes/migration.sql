-- Follow-up zu 20260504130000_faction_discord_only:
-- Die urspruenglichen Uniques wurden mit `CREATE UNIQUE INDEX` angelegt
-- (nicht als TABLE-CONSTRAINT), daher hat `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`
-- in der vorigen Migration silently nichts entfernt. Hier korrekt aufraeumen.

DROP INDEX IF EXISTS "Faction_guildId_nitradoConnId_name_key";
DROP INDEX IF EXISTS "FactionSystemConfig_guildId_nitradoConnId_key";
