CREATE TABLE "NitradoDriftNotice" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "subjectKey" VARCHAR(128) NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NitradoDriftNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NitradoDriftNotice_guildId_nitradoConnId_kind_subjectKey_key"
  ON "NitradoDriftNotice"("guildId", "nitradoConnId", "kind", "subjectKey");
CREATE INDEX "NitradoDriftNotice_guildId_nitradoConnId_idx"
  ON "NitradoDriftNotice"("guildId", "nitradoConnId");