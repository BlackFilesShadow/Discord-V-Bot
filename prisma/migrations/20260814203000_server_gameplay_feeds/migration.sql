-- Phase 11: persistente, gameserver-gescoppte Server-Gameplay-Feeds.
-- Bewusst getrennt von der bestehenden externen Feed-Tabelle (RSS/Twitch/etc.).

CREATE TABLE IF NOT EXISTS "ServerFeedConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" VARCHAR(32) NOT NULL,
    "feedType" VARCHAR(32) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin',
    "startAt" TIMESTAMP(3) NOT NULL,
    "intervalSeconds" INTEGER NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "cursorOccurredAt" TIMESTAMP(3),
    "cursorEventId" TEXT,
    "leaseOwner" VARCHAR(96),
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deadLetterAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerFeedConfig_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServerFeedConfig_feedType_check" CHECK ("feedType" IN ('BUILD','FLAG_ACTIVITY','PLACEMENT','ONLINE_LIST','PLAYER_POSITION')),
    CONSTRAINT "ServerFeedConfig_interval_check" CHECK ("intervalSeconds" BETWEEN 60 AND 86400),
    CONSTRAINT "ServerFeedConfig_failureCount_check" CHECK ("failureCount" >= 0),
    CONSTRAINT "ServerFeedConfig_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServerFeedConfig_scope_channel_type_key"
    ON "ServerFeedConfig"("guildId", "nitradoConnId", "channelId", "feedType");
CREATE INDEX IF NOT EXISTS "ServerFeedConfig_due_idx"
    ON "ServerFeedConfig"("isActive", "deadLetterAt", "nextRunAt", "leaseUntil");
CREATE INDEX IF NOT EXISTS "ServerFeedConfig_scope_idx"
    ON "ServerFeedConfig"("guildId", "nitradoConnId");

CREATE TABLE IF NOT EXISTS "ServerFeedDelivery" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "sourceKey" VARCHAR(220) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'CLAIMED',
    "messageId" VARCHAR(32),
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "ServerFeedDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServerFeedDelivery_status_check" CHECK ("status" IN ('CLAIMED','SENT','FAILED')),
    CONSTRAINT "ServerFeedDelivery_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ServerFeedConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Claim-before-send: dieselbe Feed-Ausgabe kann auch nach Restart nicht ein
-- zweites Mal zugestellt werden. Das priorisiert keine Doppelposts gegenüber
-- einem theoretischen Crash exakt zwischen Claim und Discord-Send.
CREATE UNIQUE INDEX IF NOT EXISTS "ServerFeedDelivery_config_source_key"
    ON "ServerFeedDelivery"("configId", "sourceKey");
CREATE INDEX IF NOT EXISTS "ServerFeedDelivery_status_idx"
    ON "ServerFeedDelivery"("configId", "status", "claimedAt");
