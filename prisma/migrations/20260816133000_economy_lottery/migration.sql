-- Etappe 6B: servergescoppte Economy-Lotterie auf EconomyVirtualAccount.
-- Additiv; bestehende Economy-/VirtualAccount-Daten bleiben unveraendert.

ALTER TYPE "EconomyTxType" ADD VALUE IF NOT EXISTS 'LOTTERY_TICKET';
ALTER TYPE "EconomyTxType" ADD VALUE IF NOT EXISTS 'LOTTERY_PAYOUT';
ALTER TYPE "EconomyTxType" ADD VALUE IF NOT EXISTS 'LOTTERY_REFUND';

CREATE TYPE "LotteryRoundStatus" AS ENUM ('ACTIVE', 'DRAWING', 'REFUNDING', 'FINISHED', 'REFUNDED');

CREATE TABLE "LotteryRound" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "potAccountId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "ticketPrice" BIGINT NOT NULL,
    "maxTicketsPerUser" INTEGER NOT NULL,
    "minParticipants" INTEGER NOT NULL,
    "status" "LotteryRoundStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeScopeKey" VARCHAR(160),
    "endsAt" TIMESTAMP(3) NOT NULL,
    "winnerDiscordId" TEXT,
    "winningTicketNumber" INTEGER,
    "participantCount" INTEGER NOT NULL DEFAULT 0,
    "totalTickets" INTEGER NOT NULL DEFAULT 0,
    "finalPot" BIGINT,
    "drawnAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "announcedAt" TIMESTAMP(3),
    "createdByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LotteryRound_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LotteryRound_ticketPrice_positive" CHECK ("ticketPrice" > 0),
    CONSTRAINT "LotteryRound_maxTickets_range" CHECK ("maxTicketsPerUser" BETWEEN 1 AND 10000),
    CONSTRAINT "LotteryRound_minParticipants_range" CHECK ("minParticipants" BETWEEN 2 AND 100000),
    CONSTRAINT "LotteryRound_participantCount_nonnegative" CHECK ("participantCount" >= 0),
    CONSTRAINT "LotteryRound_totalTickets_nonnegative" CHECK ("totalTickets" >= 0),
    CONSTRAINT "LotteryRound_finalPot_nonnegative" CHECK ("finalPot" IS NULL OR "finalPot" >= 0),
    CONSTRAINT "LotteryRound_winningTicket_positive" CHECK ("winningTicketNumber" IS NULL OR "winningTicketNumber" >= 1)
);

CREATE UNIQUE INDEX "LotteryRound_activeScopeKey_key" ON "LotteryRound"("activeScopeKey");
CREATE INDEX "LotteryRound_scope_status_ends_idx" ON "LotteryRound"("guildId", "nitradoConnId", "status", "endsAt");
CREATE INDEX "LotteryRound_scope_created_idx" ON "LotteryRound"("guildId", "nitradoConnId", "createdAt" DESC);

CREATE TABLE "LotteryEntry" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "totalPaid" BIGINT NOT NULL,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LotteryEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LotteryEntry_ticketCount_positive" CHECK ("ticketCount" > 0),
    CONSTRAINT "LotteryEntry_totalPaid_nonnegative" CHECK ("totalPaid" >= 0)
);

CREATE UNIQUE INDEX "LotteryEntry_round_user_key" ON "LotteryEntry"("roundId", "userDiscordId");
CREATE INDEX "LotteryEntry_scope_user_idx" ON "LotteryEntry"("guildId", "nitradoConnId", "userDiscordId");
CREATE INDEX "LotteryEntry_round_refund_idx" ON "LotteryEntry"("roundId", "refundedAt");

CREATE TABLE "LotteryPurchase" (
    "id" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "roundId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotteryPurchase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LotteryPurchase_ticketCount_positive" CHECK ("ticketCount" > 0),
    CONSTRAINT "LotteryPurchase_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "LotteryPurchase_idempotencyKey_key" ON "LotteryPurchase"("idempotencyKey");
CREATE INDEX "LotteryPurchase_round_user_created_idx" ON "LotteryPurchase"("roundId", "userDiscordId", "createdAt" DESC);

ALTER TABLE "LotteryRound"
    ADD CONSTRAINT "LotteryRound_potAccountId_fkey"
    FOREIGN KEY ("potAccountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryEntry"
    ADD CONSTRAINT "LotteryEntry_roundId_fkey"
    FOREIGN KEY ("roundId") REFERENCES "LotteryRound"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryPurchase"
    ADD CONSTRAINT "LotteryPurchase_roundId_fkey"
    FOREIGN KEY ("roundId") REFERENCES "LotteryRound"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;