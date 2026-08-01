-- CreateEnum
CREATE TYPE "GameIdentityStatus" AS ENUM ('PENDING', 'VERIFIED', 'UNLINKED');

-- CreateTable
CREATE TABLE "GameIdentityLink" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "identityHash" VARCHAR(64) NOT NULL,
    "status" "GameIdentityStatus" NOT NULL DEFAULT 'PENDING',
    "challengeCode" VARCHAR(16),
    "challengeExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "unlinkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameIdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameIdentityLink_guildId_nitradoConnId_status_idx" ON "GameIdentityLink"("guildId", "nitradoConnId", "status");

-- CreateIndex
CREATE INDEX "GameIdentityLink_guildId_nitradoConnId_challengeCode_idx" ON "GameIdentityLink"("guildId", "nitradoConnId", "challengeCode");

-- CreateIndex
CREATE UNIQUE INDEX "GameIdentityLink_guildId_nitradoConnId_userDiscordId_key" ON "GameIdentityLink"("guildId", "nitradoConnId", "userDiscordId");

-- CreateIndex
CREATE UNIQUE INDEX "GameIdentityLink_guildId_nitradoConnId_identityHash_key" ON "GameIdentityLink"("guildId", "nitradoConnId", "identityHash");
