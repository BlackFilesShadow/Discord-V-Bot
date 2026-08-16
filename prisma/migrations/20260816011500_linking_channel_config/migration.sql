CREATE TABLE "LinkingChannelConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "infoMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkingChannelConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LinkingChannelConfig_guildId_nitradoConnId_key"
ON "LinkingChannelConfig"("guildId", "nitradoConnId");

CREATE INDEX "LinkingChannelConfig_guildId_channelId_idx"
ON "LinkingChannelConfig"("guildId", "channelId");

CREATE INDEX "LinkingChannelConfig_nitradoConnId_idx"
ON "LinkingChannelConfig"("nitradoConnId");
