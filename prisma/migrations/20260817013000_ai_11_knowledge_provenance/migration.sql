CREATE TABLE "GuildKnowledgeProvenance" (
    "knowledgeId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "trustLevel" TEXT NOT NULL,
    "sourceRef" TEXT,
    "sourceVersion" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GuildKnowledgeProvenance_pkey" PRIMARY KEY ("knowledgeId")
);

CREATE INDEX "GuildKnowledgeProvenance_guildId_sourceKind_idx"
    ON "GuildKnowledgeProvenance"("guildId", "sourceKind");
CREATE INDEX "GuildKnowledgeProvenance_guildId_trustLevel_idx"
    ON "GuildKnowledgeProvenance"("guildId", "trustLevel");
CREATE INDEX "GuildKnowledgeProvenance_validUntil_idx"
    ON "GuildKnowledgeProvenance"("validUntil");
CREATE INDEX "GuildKnowledgeProvenance_observedAt_idx"
    ON "GuildKnowledgeProvenance"("observedAt");
