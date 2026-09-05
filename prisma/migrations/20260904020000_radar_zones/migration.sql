CREATE TYPE "RadarMap" AS ENUM ('CHERNARUS', 'LIVONIA', 'SAKHAL');
CREATE TYPE "RadarZoneShape" AS ENUM ('CIRCLE', 'POLYGON');
CREATE TYPE "RadarAllowlistSource" AS ENUM ('SERVER_WHITELIST', 'MANUAL');
CREATE TYPE "RadarDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'RETRY', 'FAILED');

CREATE TABLE "RadarConfig" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "activeMap" "RadarMap" NOT NULL DEFAULT 'CHERNARUS',
  "cursorCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cursorEventId" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RadarConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RadarZone" (
  "id" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "map" "RadarMap" NOT NULL,
  "shape" "RadarZoneShape" NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "centerX" DECIMAL(12,3), "centerY" DECIMAL(12,3), "radiusMeters" DECIMAL(12,3),
  "minX" DECIMAL(12,3) NOT NULL, "minY" DECIMAL(12,3) NOT NULL,
  "maxX" DECIMAL(12,3) NOT NULL, "maxY" DECIMAL(12,3) NOT NULL,
  "channelId" VARCHAR(32) NOT NULL,
  "rolePingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "roleIds" TEXT[] NOT NULL,
  "embedColor" VARCHAR(9) NOT NULL DEFAULT '#dc2626',
  "editorCenterX" DECIMAL(12,3), "editorCenterY" DECIMAL(12,3),
  "editorZoom" DECIMAL(8,3), "editorBearing" DECIMAL(8,3), "editorPitch" DECIMAL(8,3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" VARCHAR(32) NOT NULL, "updatedBy" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RadarZone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RadarZone_configId_fkey" FOREIGN KEY ("configId") REFERENCES "RadarConfig"("id") ON DELETE CASCADE
);

CREATE TABLE "RadarZonePoint" (
  "id" TEXT NOT NULL, "zoneId" TEXT NOT NULL, "position" INTEGER NOT NULL,
  "x" DECIMAL(12,3) NOT NULL, "y" DECIMAL(12,3) NOT NULL,
  CONSTRAINT "RadarZonePoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RadarZonePoint_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "RadarZone"("id") ON DELETE CASCADE
);

CREATE TABLE "RadarZoneFunction" (
  "id" TEXT NOT NULL, "zoneId" TEXT NOT NULL, "functionKey" VARCHAR(80) NOT NULL,
  CONSTRAINT "RadarZoneFunction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RadarZoneFunction_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "RadarZone"("id") ON DELETE CASCADE
);

CREATE TABLE "RadarZoneAllowlist" (
  "id" TEXT NOT NULL, "zoneId" TEXT NOT NULL, "source" "RadarAllowlistSource" NOT NULL,
  "gameId" VARCHAR(128) NOT NULL, "playerName" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RadarZoneAllowlist_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RadarZoneAllowlist_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "RadarZone"("id") ON DELETE CASCADE
);

CREATE TABLE "RadarZoneEvent" (
  "id" TEXT NOT NULL, "zoneId" TEXT NOT NULL, "admEventId" TEXT NOT NULL,
  "functionKey" VARCHAR(80) NOT NULL, "guildId" TEXT NOT NULL, "nitradoConnId" TEXT NOT NULL,
  "channelId" VARCHAR(32) NOT NULL, "admEventType" "AdmEventType" NOT NULL,
  "actorGameId" VARCHAR(128), "actorName" VARCHAR(128), "targetGameId" VARCHAR(128), "targetName" VARCHAR(128),
  "objectType" VARCHAR(256), "toolOrWeapon" VARCHAR(256), "distanceMeters" DECIMAL(12,3),
  "x" DECIMAL(12,3) NOT NULL, "y" DECIMAL(12,3) NOT NULL, "altitude" DECIMAL(12,3),
  "admOccurredAt" TIMESTAMP(3), "status" "RadarDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3), "messageId" VARCHAR(32), "lastError" TEXT, "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RadarZoneEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RadarZoneEvent_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "RadarZone"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "RadarConfig_guildId_nitradoConnId_key" ON "RadarConfig"("guildId", "nitradoConnId");
CREATE INDEX "RadarConfig_nitradoConnId_idx" ON "RadarConfig"("nitradoConnId");
CREATE INDEX "RadarZone_guildId_nitradoConnId_map_isActive_idx" ON "RadarZone"("guildId", "nitradoConnId", "map", "isActive");
CREATE INDEX "RadarZone_configId_map_isActive_idx" ON "RadarZone"("configId", "map", "isActive");
CREATE UNIQUE INDEX "RadarZonePoint_zoneId_position_key" ON "RadarZonePoint"("zoneId", "position");
CREATE UNIQUE INDEX "RadarZoneFunction_zoneId_functionKey_key" ON "RadarZoneFunction"("zoneId", "functionKey");
CREATE INDEX "RadarZoneFunction_functionKey_idx" ON "RadarZoneFunction"("functionKey");
CREATE UNIQUE INDEX "RadarZoneAllowlist_zoneId_gameId_key" ON "RadarZoneAllowlist"("zoneId", "gameId");
CREATE INDEX "RadarZoneAllowlist_gameId_idx" ON "RadarZoneAllowlist"("gameId");
CREATE UNIQUE INDEX "RadarZoneEvent_zoneId_admEventId_functionKey_key" ON "RadarZoneEvent"("zoneId", "admEventId", "functionKey");
CREATE INDEX "RadarZoneEvent_guildId_nitradoConnId_status_nextAttemptAt_idx" ON "RadarZoneEvent"("guildId", "nitradoConnId", "status", "nextAttemptAt");
CREATE INDEX "RadarZoneEvent_zoneId_sentAt_idx" ON "RadarZoneEvent"("zoneId", "sentAt");