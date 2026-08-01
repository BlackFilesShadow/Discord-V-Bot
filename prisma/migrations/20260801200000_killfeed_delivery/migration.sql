-- CreateTable
CREATE TABLE "KillfeedDelivery" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "admEventId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" VARCHAR(32) NOT NULL,
    "messageId" VARCHAR(32),
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KillfeedDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KillfeedDelivery_guildId_admEventId_idx" ON "KillfeedDelivery"("guildId", "admEventId");

-- CreateIndex
CREATE UNIQUE INDEX "KillfeedDelivery_configId_admEventId_key" ON "KillfeedDelivery"("configId", "admEventId");
