-- CreateTable
CREATE TABLE "EconomySlotConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "admRewardsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rewardTarget" "EconomyRewardTarget" NOT NULL DEFAULT 'WALLET',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomySlotConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EconomySlotConfig_guildId_idx" ON "EconomySlotConfig"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomySlotConfig_guildId_nitradoConnId_key" ON "EconomySlotConfig"("guildId", "nitradoConnId");
