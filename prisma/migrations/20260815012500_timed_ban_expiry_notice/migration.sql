CREATE TABLE IF NOT EXISTS "ServerBanExpiryNotice" (
  "id" TEXT NOT NULL,
  "banId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "channelId" VARCHAR(32) NOT NULL,
  "identifierEnc" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "remoteRemovedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "messageId" VARCHAR(32),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServerBanExpiryNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServerBanExpiryNotice_banId_key"
  ON "ServerBanExpiryNotice"("banId");
CREATE INDEX IF NOT EXISTS "ServerBanExpiryNotice_status_nextAttemptAt_idx"
  ON "ServerBanExpiryNotice"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "ServerBanExpiryNotice_guildId_nitradoConnId_idx"
  ON "ServerBanExpiryNotice"("guildId", "nitradoConnId");
CREATE INDEX IF NOT EXISTS "ServerBanExpiryNotice_expiresAt_status_idx"
  ON "ServerBanExpiryNotice"("expiresAt", "status");
