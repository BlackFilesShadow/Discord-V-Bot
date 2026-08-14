-- Unified Deathfeed/Baufeed V2 with retryable delivery state.
DO $$ BEGIN
  CREATE TYPE "GameplayFeedKind" AS ENUM ('DEATH', 'BUILD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GameplayDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'RETRY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "NitradoAdmProfileConfig" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "profileDir" TEXT NOT NULL,
  "source" VARCHAR(24) NOT NULL DEFAULT 'AUTO',
  "timeZone" VARCHAR(80),
  "lastVerifiedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NitradoAdmProfileConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "NitradoAdmProfileConfig_scope_key"
  ON "NitradoAdmProfileConfig"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "NitradoAdmProfileConfig_nitradoConnId_idx"
  ON "NitradoAdmProfileConfig"("nitradoConnId");

CREATE TABLE IF NOT EXISTS "GameplayFeedConfig" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "kind" "GameplayFeedKind" NOT NULL,
  "channelId" VARCHAR(32) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "categories" TEXT[] NOT NULL,
  "showActorCoords" BOOLEAN NOT NULL DEFAULT true,
  "showTargetCoords" BOOLEAN NOT NULL DEFAULT false,
  "showTool" BOOLEAN NOT NULL DEFAULT true,
  "showDistance" BOOLEAN NOT NULL DEFAULT true,
  "embedColor" VARCHAR(9) NOT NULL DEFAULT '#dc2626',
  "legacyKillfeedConfigId" TEXT,
  "cursorCreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cursorEventId" TEXT NOT NULL DEFAULT '',
  "lastEventAt" TIMESTAMP(3),
  "lastPolledAt" TIMESTAMP(3),
  "lastErrorMsg" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameplayFeedConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "GameplayFeedDelivery" (
  "id" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "admEventId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "channelId" VARCHAR(32) NOT NULL,
  "status" "GameplayDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "messageId" VARCHAR(32),
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GameplayFeedDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GameplayFeedDelivery_configId_fkey"
    FOREIGN KEY ("configId") REFERENCES "GameplayFeedConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "GameplayFeedConfig_legacyKillfeedConfigId_key"
  ON "GameplayFeedConfig"("legacyKillfeedConfigId");
CREATE UNIQUE INDEX IF NOT EXISTS "GameplayFeedConfig_scope_kind_channel_key"
  ON "GameplayFeedConfig"("guildId", "nitradoConnId", "kind", "channelId");
CREATE INDEX IF NOT EXISTS "GameplayFeedConfig_scope_active_idx"
  ON "GameplayFeedConfig"("guildId", "nitradoConnId", "kind", "isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "GameplayFeedDelivery_config_event_key"
  ON "GameplayFeedDelivery"("configId", "admEventId");
CREATE INDEX IF NOT EXISTS "GameplayFeedDelivery_status_next_idx"
  ON "GameplayFeedDelivery"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "GameplayFeedDelivery_scope_status_idx"
  ON "GameplayFeedDelivery"("guildId", "nitradoConnId", "status");
CREATE INDEX IF NOT EXISTS "GameplayFeedDelivery_config_sent_idx"
  ON "GameplayFeedDelivery"("configId", "sentAt");

-- Existing KillfeedConfig rows become DEATH feeds. Historical DEATH meant PvP,
-- therefore map it to PVP while preserving the other selected categories.
INSERT INTO "GameplayFeedConfig" (
  "id", "guildId", "nitradoConnId", "kind", "channelId", "isActive",
  "categories", "showActorCoords", "showTargetCoords", "showTool", "showDistance",
  "embedColor", "legacyKillfeedConfigId", "cursorCreatedAt", "cursorEventId",
  "lastEventAt", "lastPolledAt", "lastErrorMsg", "createdAt", "updatedAt"
)
SELECT
  k."id",
  k."guildId",
  k."nitradoConnId",
  'DEATH'::"GameplayFeedKind",
  k."channelId",
  k."isActive",
  ARRAY(
    SELECT CASE WHEN c::text = 'DEATH' THEN 'PVP' ELSE c::text END
    FROM unnest(k."categories") AS c
  ),
  k."showVictimCoords",
  k."showShooterCoords",
  k."showWeapon",
  k."showDistance",
  k."embedColor",
  k."id",
  COALESCE(k."lastEventAt", CURRENT_TIMESTAMP),
  '',
  k."lastEventAt",
  k."lastPolledAt",
  k."lastErrorMsg",
  k."createdAt",
  k."updatedAt"
FROM "KillfeedConfig" k
ON CONFLICT ("id") DO NOTHING;

-- Preserve successful old deliveries. A legacy claim without messageId is not
-- proof of a Discord post and is deliberately made retryable instead of lost.
INSERT INTO "GameplayFeedDelivery" (
  "id", "configId", "admEventId", "guildId", "nitradoConnId", "channelId",
  "status", "attempts", "nextAttemptAt", "leaseUntil", "messageId", "lastError",
  "sentAt", "createdAt", "updatedAt"
)
SELECT
  d."id",
  d."configId",
  d."admEventId",
  d."guildId",
  k."nitradoConnId",
  d."channelId",
  CASE WHEN d."messageId" IS NULL THEN 'RETRY'::"GameplayDeliveryStatus"
       ELSE 'SENT'::"GameplayDeliveryStatus" END,
  0,
  CURRENT_TIMESTAMP,
  NULL,
  d."messageId",
  CASE WHEN d."messageId" IS NULL THEN 'Migrated unfinished legacy delivery claim' ELSE NULL END,
  CASE WHEN d."messageId" IS NULL THEN NULL ELSE d."deliveredAt" END,
  d."deliveredAt",
  CURRENT_TIMESTAMP
FROM "KillfeedDelivery" d
JOIN "GameplayFeedConfig" k ON k."id" = d."configId"
ON CONFLICT ("configId", "admEventId") DO NOTHING;