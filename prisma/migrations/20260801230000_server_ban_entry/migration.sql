-- CreateTable
CREATE TABLE "ServerBanEntry" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "identityHash" VARCHAR(64) NOT NULL,
    "gameLabel" VARCHAR(120),
    "reason" VARCHAR(300),
    "bannedByDiscordId" TEXT NOT NULL,
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "appliedRemotely" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerBanEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerBanEntry_guildId_nitradoConnId_active_idx" ON "ServerBanEntry"("guildId", "nitradoConnId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ServerBanEntry_guildId_nitradoConnId_identityHash_key" ON "ServerBanEntry"("guildId", "nitradoConnId", "identityHash");
