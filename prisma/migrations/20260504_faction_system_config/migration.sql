-- Faction-System-Config pro (Guild + Nitrado-Slot)
CREATE TABLE "FactionSystemConfig" (
  "id"                TEXT PRIMARY KEY,
  "guildId"           TEXT NOT NULL,
  "nitradoConnId"     TEXT NOT NULL,
  "factionChannelId"  TEXT,
  "listMessageId"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FactionSystemConfig_nitradoConnId_fkey"
    FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "FactionSystemConfig_guildId_nitradoConnId_key"
  ON "FactionSystemConfig"("guildId", "nitradoConnId");

CREATE INDEX "FactionSystemConfig_guildId_idx"
  ON "FactionSystemConfig"("guildId");
