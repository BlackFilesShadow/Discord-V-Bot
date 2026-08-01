-- CreateEnum
CREATE TYPE "AdmEventType" AS ENUM ('PLAYER_CONNECTED', 'PLAYER_DISCONNECTED', 'PLAYER_HIT', 'PLAYER_KILLED', 'PLAYER_DIED', 'PLAYER_SUICIDE', 'NPC_KILL', 'VEHICLE_DEATH', 'BUILD', 'DISMANTLE', 'DESTROY', 'PLACEMENT', 'PLAYER_POSITION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RewardDecisionStatus" AS ENUM ('PENDING', 'PAID', 'SKIPPED', 'REVIEW', 'FAILED_RETRYABLE', 'ERROR');

-- CreateTable
CREATE TABLE "AdmSourceCursor" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "fileIdentity" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "lastModifiedAt" INTEGER NOT NULL,
    "lastKnownSize" BIGINT NOT NULL DEFAULT 0,
    "processedByteOffset" BIGINT NOT NULL DEFAULT 0,
    "trailingPartialLine" TEXT,
    "contentFingerprint" VARCHAR(64),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmSourceCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmEvent" (
    "id" TEXT NOT NULL,
    "eventKey" VARCHAR(64) NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "sourceByteStart" BIGINT NOT NULL,
    "sourceByteEnd" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "eventType" "AdmEventType" NOT NULL,
    "actorGameId" TEXT,
    "actorName" TEXT,
    "targetGameId" TEXT,
    "targetName" TEXT,
    "objectType" TEXT,
    "toolOrWeapon" TEXT,
    "distanceMeters" DOUBLE PRECISION,
    "actorPosition" TEXT,
    "targetPosition" TEXT,
    "rawLine" TEXT NOT NULL,
    "parserVersion" INTEGER NOT NULL DEFAULT 1,
    "parseStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardDecision" (
    "id" TEXT NOT NULL,
    "admEventId" TEXT NOT NULL,
    "rewardRuleId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT,
    "status" "RewardDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "calculated" BIGINT NOT NULL DEFAULT 0,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdmSourceCursor_guildId_nitradoConnId_fileIdentity_key" ON "AdmSourceCursor"("guildId", "nitradoConnId", "fileIdentity");

-- CreateIndex
CREATE INDEX "AdmSourceCursor_guildId_nitradoConnId_idx" ON "AdmSourceCursor"("guildId", "nitradoConnId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmEvent_eventKey_key" ON "AdmEvent"("eventKey");

-- CreateIndex
CREATE INDEX "AdmEvent_guildId_nitradoConnId_occurredAt_idx" ON "AdmEvent"("guildId", "nitradoConnId", "occurredAt");

-- CreateIndex
CREATE INDEX "AdmEvent_eventType_occurredAt_idx" ON "AdmEvent"("eventType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardDecision_admEventId_rewardRuleId_key" ON "RewardDecision"("admEventId", "rewardRuleId");

-- CreateIndex
CREATE INDEX "RewardDecision_guildId_nitradoConnId_status_idx" ON "RewardDecision"("guildId", "nitradoConnId", "status");
