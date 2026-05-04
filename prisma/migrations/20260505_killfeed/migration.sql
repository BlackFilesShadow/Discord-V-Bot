-- Killfeed: live PvP-Tracking aus DayZ-ADM-Logs
-- Polling im 60s-Takt mit ETag/If-Modified-Since.

CREATE TYPE "KillCategory" AS ENUM ('DEATH', 'SUICIDE', 'NPC', 'VEHICLE');

CREATE TABLE "KillfeedConfig" (
  "id"                 TEXT PRIMARY KEY,
  "guildId"            TEXT NOT NULL,
  "nitradoConnId"      TEXT NOT NULL,
  "channelId"          VARCHAR(32) NOT NULL,
  "isActive"           BOOLEAN NOT NULL DEFAULT true,
  "categories"         "KillCategory"[] NOT NULL DEFAULT ARRAY[]::"KillCategory"[],
  "showShooterCoords"  BOOLEAN NOT NULL DEFAULT false,
  "showVictimCoords"   BOOLEAN NOT NULL DEFAULT true,
  "showWeapon"         BOOLEAN NOT NULL DEFAULT true,
  "showDistance"       BOOLEAN NOT NULL DEFAULT true,
  "embedColor"         VARCHAR(9) NOT NULL DEFAULT '#dc2626',
  "lastEventAt"        TIMESTAMP(3),
  "lastEtag"           VARCHAR(128),
  "lastFileName"       VARCHAR(256),
  "lastByteOffset"     BIGINT NOT NULL DEFAULT 0,
  "lastPolledAt"       TIMESTAMP(3),
  "lastErrorMsg"       TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KillfeedConfig_nitradoConnId_fkey"
    FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "KillfeedConfig_guildId_nitradoConnId_channelId_key"
  ON "KillfeedConfig"("guildId", "nitradoConnId", "channelId");
CREATE INDEX "KillfeedConfig_guildId_nitradoConnId_idx"
  ON "KillfeedConfig"("guildId", "nitradoConnId");
CREATE INDEX "KillfeedConfig_guildId_isActive_idx"
  ON "KillfeedConfig"("guildId", "isActive");

CREATE TABLE "KillfeedEvent" (
  "id"            TEXT PRIMARY KEY,
  "guildId"       TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "category"      "KillCategory" NOT NULL,
  "occurredAt"    TIMESTAMP(3) NOT NULL,
  "shooterName"   VARCHAR(120),
  "shooterPos"    VARCHAR(120),
  "victimName"    VARCHAR(120) NOT NULL,
  "victimPos"     VARCHAR(120),
  "weapon"        VARCHAR(120),
  "distance"      DOUBLE PRECISION,
  "rawLine"       TEXT NOT NULL,
  "postedAt"      TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KillfeedEvent_nitradoConnId_fkey"
    FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE
);

CREATE INDEX "KillfeedEvent_guildId_nitradoConnId_occurredAt_idx"
  ON "KillfeedEvent"("guildId", "nitradoConnId", "occurredAt");
CREATE INDEX "KillfeedEvent_guildId_nitradoConnId_category_idx"
  ON "KillfeedEvent"("guildId", "nitradoConnId", "category");
