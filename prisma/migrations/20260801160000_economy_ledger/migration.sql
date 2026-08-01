-- CreateTable
CREATE TABLE "EconomyLedgerEntry" (
    "id" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT,
    "userDiscordId" TEXT NOT NULL,
    "walletDelta" BIGINT NOT NULL DEFAULT 0,
    "bankDelta" BIGINT NOT NULL DEFAULT 0,
    "type" "EconomyTxType" NOT NULL,
    "reason" VARCHAR(200),
    "buckets" INTEGER NOT NULL DEFAULT 0,
    "sourceRef" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EconomyLedgerEntry_idempotencyKey_key" ON "EconomyLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EconomyLedgerEntry_guildId_userDiscordId_createdAt_idx" ON "EconomyLedgerEntry"("guildId", "userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomyLedgerEntry_guildId_nitradoConnId_type_idx" ON "EconomyLedgerEntry"("guildId", "nitradoConnId", "type");
