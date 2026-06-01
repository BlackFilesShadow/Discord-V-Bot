-- Mandantentrennung (Multi-Tenancy): guildId fuer Poll, Giveaway, Feed, AutoModFilter
-- Additiv und reversibel: Spalten sind NULLABLE, Bestandszeilen bleiben NULL.
-- Es gibt KEINE zuverlaessige Backfill-Quelle (nur channelId ist gespeichert),
-- daher kein UPDATE-Backfill. Anwendungscode muss beim Erstellen guildId setzen
-- und beim Lesen nach guildId filtern, bevor diese Spalten Schutz bieten.

ALTER TABLE "Poll" ADD COLUMN IF NOT EXISTS "guildId" TEXT;
ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "guildId" TEXT;
ALTER TABLE "Feed" ADD COLUMN IF NOT EXISTS "guildId" TEXT;
ALTER TABLE "AutoModFilter" ADD COLUMN IF NOT EXISTS "guildId" TEXT;

CREATE INDEX IF NOT EXISTS "Poll_guildId_idx" ON "Poll" ("guildId");
CREATE INDEX IF NOT EXISTS "Giveaway_guildId_idx" ON "Giveaway" ("guildId");
CREATE INDEX IF NOT EXISTS "Feed_guildId_idx" ON "Feed" ("guildId");
CREATE INDEX IF NOT EXISTS "AutoModFilter_guildId_idx" ON "AutoModFilter" ("guildId");
