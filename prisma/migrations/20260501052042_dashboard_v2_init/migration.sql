-- CreateEnum
CREATE TYPE "NitradoConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'PROBE_FAILED');

-- CreateEnum
CREATE TYPE "WhitelistRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EconomyTxType" AS ENUM ('PAY', 'ADMIN_PAY', 'DEPOSIT', 'WITHDRAW', 'TRANSFER', 'CASINO_BET', 'CASINO_PAYOUT', 'PLAYTIME_REWARD', 'STARTBALANCE_JOIN', 'GRANT', 'FINE', 'INTEREST');

-- CreateEnum
CREATE TYPE "CasinoGameType" AS ENUM ('SLOT', 'COINFLIP', 'DICE', 'BLACKJACK');

-- CreateEnum
CREATE TYPE "NitradoJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- DropIndex
DROP INDEX "LevelData_userId_key";

-- AlterTable
ALTER TABLE "Feed" ADD COLUMN     "mentionRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "webhookSecret" TEXT;

-- AlterTable
ALTER TABLE "GuildKnowledge" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GuildMemberProfile" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GuildProfile" ADD COLUMN     "feedbackChannelId" TEXT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LevelData" ADD COLUMN     "guildId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "XpRecord" ADD COLUMN     "guildId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notifyChannelId" TEXT,
    "notifyMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "guildId" TEXT,
    "channelId" TEXT,
    "message" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceMs" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfRoleMenu" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'MULTI',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfRoleMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfRoleOption" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "emoji" TEXT,
    "description" VARCHAR(100),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfRoleOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardGuildLink" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerDiscordId" TEXT NOT NULL,
    "alias5" VARCHAR(5) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardGuildLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NitradoConnection" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "alias" VARCHAR(40) NOT NULL,
    "alias5" VARCHAR(5) NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "nitradoServerId" TEXT,
    "serviceId" TEXT,
    "status" "NitradoConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastValidatedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "addedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildPermissionGrant" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "grantedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildPermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSettings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "whitelistActive" BOOLEAN NOT NULL DEFAULT false,
    "economyActive" BOOLEAN NOT NULL DEFAULT false,
    "permaOnly" BOOLEAN NOT NULL DEFAULT false,
    "whitelistChannelId" TEXT,
    "whitelistRequestChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "flagUrl" TEXT NOT NULL,
    "bannerUrl" TEXT,
    "mediaUrl" TEXT,
    "leaderDiscordId" TEXT,
    "treasurerDiscordId" TEXT,
    "embedChannelId" TEXT,
    "embedMessageId" TEXT,
    "joinPolicy" TEXT NOT NULL DEFAULT 'REQUEST',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactionMember" (
    "id" TEXT NOT NULL,
    "factionId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistEntry" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "approvedByDiscordId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DIRECT',
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistRequest" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "requesterDiscordId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "status" "WhitelistRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByDiscordId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "currencyName" VARCHAR(40) NOT NULL DEFAULT 'Coins',
    "emoji" VARCHAR(40) NOT NULL DEFAULT '💰',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startBalance" INTEGER NOT NULL DEFAULT 0,
    "playtimeRewardPercent" INTEGER NOT NULL DEFAULT 5,
    "bankChannelId" TEXT,
    "bankInterestPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyAccount" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "walletBalance" BIGINT NOT NULL DEFAULT 0,
    "bankBalance" BIGINT NOT NULL DEFAULT 0,
    "lifetimeEarned" BIGINT NOT NULL DEFAULT 0,
    "lifetimeSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyTransaction" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "delta" BIGINT NOT NULL,
    "type" "EconomyTxType" NOT NULL,
    "reason" VARCHAR(200),
    "actorDiscordId" TEXT,
    "counterpartDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomyLink" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "EconomyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasinoGame" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" "CasinoGameType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "winChancePct" INTEGER NOT NULL DEFAULT 45,
    "minBet" BIGINT NOT NULL DEFAULT 1,
    "maxBet" BIGINT NOT NULL DEFAULT 10000,
    "payoutMult" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasinoGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasinoRound" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "bet" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL,
    "serverSeed" VARCHAR(128) NOT NULL,
    "clientSeed" VARCHAR(128),
    "nonce" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasinoRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevSession" (
    "id" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DevSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "hash" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "NitradoJob" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NitradoJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_guildId_status_createdAt_idx" ON "Feedback"("guildId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");

-- CreateIndex
CREATE INDEX "Reminder_userId_isActive_idx" ON "Reminder"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Reminder_dueAt_isActive_idx" ON "Reminder"("dueAt", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SelfRoleMenu_messageId_key" ON "SelfRoleMenu"("messageId");

-- CreateIndex
CREATE INDEX "SelfRoleMenu_guildId_isActive_idx" ON "SelfRoleMenu"("guildId", "isActive");

-- CreateIndex
CREATE INDEX "SelfRoleOption_menuId_position_idx" ON "SelfRoleOption"("menuId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SelfRoleOption_menuId_roleId_key" ON "SelfRoleOption"("menuId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardGuildLink_guildId_key" ON "DashboardGuildLink"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardGuildLink_alias5_key" ON "DashboardGuildLink"("alias5");

-- CreateIndex
CREATE INDEX "DashboardGuildLink_ownerDiscordId_idx" ON "DashboardGuildLink"("ownerDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "NitradoConnection_alias5_key" ON "NitradoConnection"("alias5");

-- CreateIndex
CREATE INDEX "NitradoConnection_guildId_idx" ON "NitradoConnection"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "NitradoConnection_guildId_slot_key" ON "NitradoConnection"("guildId", "slot");

-- CreateIndex
CREATE INDEX "GuildPermissionGrant_guildId_idx" ON "GuildPermissionGrant"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildPermissionGrant_guildId_userDiscordId_key" ON "GuildPermissionGrant"("guildId", "userDiscordId");

-- CreateIndex
CREATE INDEX "ServerSettings_guildId_idx" ON "ServerSettings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSettings_guildId_nitradoConnId_key" ON "ServerSettings"("guildId", "nitradoConnId");

-- CreateIndex
CREATE INDEX "Faction_guildId_idx" ON "Faction"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "Faction_guildId_nitradoConnId_name_key" ON "Faction"("guildId", "nitradoConnId", "name");

-- CreateIndex
CREATE INDEX "FactionMember_userDiscordId_idx" ON "FactionMember"("userDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "FactionMember_factionId_userDiscordId_key" ON "FactionMember"("factionId", "userDiscordId");

-- CreateIndex
CREATE INDEX "WhitelistEntry_guildId_idx" ON "WhitelistEntry"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistEntry_guildId_nitradoConnId_gameId_key" ON "WhitelistEntry"("guildId", "nitradoConnId", "gameId");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistRequest_messageId_key" ON "WhitelistRequest"("messageId");

-- CreateIndex
CREATE INDEX "WhitelistRequest_guildId_status_idx" ON "WhitelistRequest"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyConfig_guildId_key" ON "EconomyConfig"("guildId");

-- CreateIndex
CREATE INDEX "EconomyConfig_guildId_idx" ON "EconomyConfig"("guildId");

-- CreateIndex
CREATE INDEX "EconomyAccount_guildId_idx" ON "EconomyAccount"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyAccount_guildId_userDiscordId_key" ON "EconomyAccount"("guildId", "userDiscordId");

-- CreateIndex
CREATE INDEX "EconomyTransaction_guildId_userDiscordId_createdAt_idx" ON "EconomyTransaction"("guildId", "userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomyTransaction_guildId_createdAt_idx" ON "EconomyTransaction"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "EconomyLink_guildId_idx" ON "EconomyLink"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyLink_guildId_nitradoConnId_userDiscordId_key" ON "EconomyLink"("guildId", "nitradoConnId", "userDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "EconomyLink_guildId_nitradoConnId_gameId_key" ON "EconomyLink"("guildId", "nitradoConnId", "gameId");

-- CreateIndex
CREATE UNIQUE INDEX "CasinoGame_guildId_type_key" ON "CasinoGame"("guildId", "type");

-- CreateIndex
CREATE INDEX "CasinoRound_guildId_userDiscordId_createdAt_idx" ON "CasinoRound"("guildId", "userDiscordId", "createdAt");

-- CreateIndex
CREATE INDEX "CasinoRound_gameId_createdAt_idx" ON "CasinoRound"("gameId", "createdAt");

-- CreateIndex
CREATE INDEX "DevSession_userDiscordId_idx" ON "DevSession"("userDiscordId");

-- CreateIndex
CREATE INDEX "DevSession_expiresAt_idx" ON "DevSession"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "NitradoJob_status_nextRunAt_idx" ON "NitradoJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "NitradoJob_guildId_idx" ON "NitradoJob"("guildId");

-- CreateIndex
CREATE INDEX "LevelData_guildId_idx" ON "LevelData"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "LevelData_userId_guildId_key" ON "LevelData"("userId", "guildId");

-- CreateIndex
CREATE INDEX "XpRecord_guildId_idx" ON "XpRecord"("guildId");

-- AddForeignKey
ALTER TABLE "SelfRoleOption" ADD CONSTRAINT "SelfRoleOption_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "SelfRoleMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSettings" ADD CONSTRAINT "ServerSettings_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Faction" ADD CONSTRAINT "Faction_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionMember" ADD CONSTRAINT "FactionMember_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhitelistRequest" ADD CONSTRAINT "WhitelistRequest_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EconomyLink" ADD CONSTRAINT "EconomyLink_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CasinoRound" ADD CONSTRAINT "CasinoRound_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "CasinoGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

