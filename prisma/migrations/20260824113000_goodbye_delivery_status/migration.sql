CREATE TYPE "GoodbyeDeliveryState" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "GoodbyeDelivery" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "discordId" VARCHAR(32) NOT NULL,
  "membershipKey" VARCHAR(64) NOT NULL,
  "cleanupRequestId" TEXT,
  "channelId" VARCHAR(32) NOT NULL,
  "messageId" VARCHAR(32),
  "discordName" VARCHAR(256) NOT NULL,
  "guildName" VARCHAR(256) NOT NULL,
  "customMessage" TEXT NOT NULL,
  "leaveOccurredAt" TIMESTAMP(3) NOT NULL,
  "cleanupEnabled" BOOLEAN NOT NULL DEFAULT false,
  "cleanupSnapshot" JSONB,
  "state" "GoodbyeDeliveryState" NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoodbyeDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoodbyeDelivery_cleanupRequestId_key" ON "GoodbyeDelivery"("cleanupRequestId");
CREATE UNIQUE INDEX "GoodbyeDelivery_guildId_membershipKey_key" ON "GoodbyeDelivery"("guildId", "membershipKey");
CREATE INDEX "GoodbyeDelivery_guildId_discordId_createdAt_idx" ON "GoodbyeDelivery"("guildId", "discordId", "createdAt");
CREATE INDEX "GoodbyeDelivery_state_updatedAt_idx" ON "GoodbyeDelivery"("state", "updatedAt");
