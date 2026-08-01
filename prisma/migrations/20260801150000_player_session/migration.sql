-- CreateEnum
CREATE TYPE "PlayerSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "PlayerSession" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "playerName" TEXT,
    "connectEventId" TEXT NOT NULL,
    "disconnectEventId" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "bucketsEarned" INTEGER NOT NULL DEFAULT 0,
    "bucketsCredited" INTEGER NOT NULL DEFAULT 0,
    "status" "PlayerSessionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerSession_connectEventId_key" ON "PlayerSession"("connectEventId");

-- CreateIndex
CREATE INDEX "PlayerSession_guildId_nitradoConnId_gameId_idx" ON "PlayerSession"("guildId", "nitradoConnId", "gameId");

-- CreateIndex
CREATE INDEX "PlayerSession_guildId_nitradoConnId_status_idx" ON "PlayerSession"("guildId", "nitradoConnId", "status");
