-- CreateEnum
CREATE TYPE "EconomyRewardTarget" AS ENUM ('WALLET', 'BANK');

-- CreateTable
CREATE TABLE "EconomyRewardRule" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "eventType" "AdmEventType",
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseAmount" BIGINT NOT NULL DEFAULT 0,
    "rewardTarget" "EconomyRewardTarget" NOT NULL DEFAULT 'WALLET',
    "dailyCap" BIGINT,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyRewardRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EconomyRewardRule_guildId_nitradoConnId_enabled_idx" ON "EconomyRewardRule"("guildId", "nitradoConnId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyRewardRule_guildId_nitradoConnId_ruleKey_key" ON "EconomyRewardRule"("guildId", "nitradoConnId", "ruleKey");
