-- Etappe 6A: servergescoppte virtuelle/temporäre Economy-Konten.
-- Additiv: bestehende EconomyAccount-/Ledger-Daten bleiben unverändert.

CREATE TYPE "EconomyVirtualAccountKind" AS ENUM ('CUSTOM', 'LOTTERY_POT', 'MARKET_VENDOR');
CREATE TYPE "EconomyVirtualAccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'ARCHIVED');

CREATE TABLE "EconomyVirtualAccount" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "kind" "EconomyVirtualAccountKind" NOT NULL DEFAULT 'CUSTOM',
    "name" VARCHAR(80) NOT NULL,
    "nameKey" VARCHAR(80) NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "status" "EconomyVirtualAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "acceptUserTransfers" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedByDiscordId" TEXT,
    "createdByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyVirtualAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EconomyVirtualAccount_balance_nonnegative" CHECK ("balance" >= 0)
);

CREATE UNIQUE INDEX "EconomyVirtualAccount_guild_conn_name_key"
    ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "nameKey");
CREATE INDEX "EconomyVirtualAccount_guild_conn_status_idx"
    ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "status");
CREATE INDEX "EconomyVirtualAccount_expiry_idx"
    ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "expiresAt")
    WHERE "expiresAt" IS NOT NULL;
CREATE INDEX "EconomyVirtualAccount_kind_idx"
    ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "kind");

CREATE TABLE "EconomyVirtualAccountEntry" (
    "id" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "virtualAccountId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "entryType" VARCHAR(40) NOT NULL,
    "sourcePocket" VARCHAR(10),
    "actorDiscordId" TEXT,
    "userDiscordId" TEXT,
    "reason" VARCHAR(200),
    "sourceRef" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualAccountEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EconomyVirtualAccountEntry_sourcePocket_check" CHECK ("sourcePocket" IS NULL OR "sourcePocket" IN ('WALLET', 'BANK'))
);

CREATE UNIQUE INDEX "EconomyVirtualAccountEntry_idempotencyKey_key"
    ON "EconomyVirtualAccountEntry"("idempotencyKey");
CREATE INDEX "EconomyVirtualAccountEntry_account_created_idx"
    ON "EconomyVirtualAccountEntry"("guildId", "nitradoConnId", "virtualAccountId", "createdAt" DESC);
CREATE INDEX "EconomyVirtualAccountEntry_user_created_idx"
    ON "EconomyVirtualAccountEntry"("guildId", "nitradoConnId", "userDiscordId", "createdAt" DESC);

ALTER TABLE "EconomyVirtualAccountEntry"
    ADD CONSTRAINT "EconomyVirtualAccountEntry_virtualAccountId_fkey"
    FOREIGN KEY ("virtualAccountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
