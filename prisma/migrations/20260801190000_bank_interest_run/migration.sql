-- CreateTable
CREATE TABLE "BankInterestRun" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "runDate" VARCHAR(10) NOT NULL,
    "interestPercent" INTEGER NOT NULL,
    "accountsCredited" INTEGER NOT NULL DEFAULT 0,
    "totalCredited" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankInterestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankInterestRun_guildId_idx" ON "BankInterestRun"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "BankInterestRun_guildId_runDate_key" ON "BankInterestRun"("guildId", "runDate");
