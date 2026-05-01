-- CreateTable
CREATE TABLE "TicketTemplate" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "welcomeText" TEXT NOT NULL,
    "embedTitle" TEXT NOT NULL,
    "embedColor" TEXT NOT NULL DEFAULT '#dc2626',
    "postChannelId" TEXT NOT NULL,
    "postedMessageId" TEXT,
    "categoryId" TEXT,
    "staffRoleId" TEXT,
    "transcriptChannelId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketInstance" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "openerDiscordId" TEXT NOT NULL,
    "openerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "transcriptMessageId" TEXT,

    CONSTRAINT "TicketInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketTemplate_guildId_slot_key" ON "TicketTemplate"("guildId", "slot");

-- CreateIndex
CREATE INDEX "TicketTemplate_guildId_idx" ON "TicketTemplate"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketInstance_channelId_key" ON "TicketInstance"("channelId");

-- CreateIndex
CREATE INDEX "TicketInstance_guildId_status_idx" ON "TicketInstance"("guildId", "status");

-- CreateIndex
CREATE INDEX "TicketInstance_templateId_idx" ON "TicketInstance"("templateId");

-- AddForeignKey
ALTER TABLE "TicketInstance" ADD CONSTRAINT "TicketInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TicketTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
