-- AI-10: optionale Gameserver-Metadaten fuer GuildKnowledge.
-- Keine Scope-Zeile = guild-global. Eine Zeile = exakt ein Nitrado-Gameserver.
-- Lifecycle-Cleanup erfolgt bewusst im Nitrado-Repository, analog zu
-- NitradoValidationHealth; so bleibt das Prisma-Multi-File-Schema drift-frei.
CREATE TABLE "GuildKnowledgeScope" (
    "knowledgeId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildKnowledgeScope_pkey" PRIMARY KEY ("knowledgeId")
);

CREATE INDEX "GuildKnowledgeScope_guildId_nitradoConnId_idx"
    ON "GuildKnowledgeScope"("guildId", "nitradoConnId");

CREATE INDEX "GuildKnowledgeScope_nitradoConnId_idx"
    ON "GuildKnowledgeScope"("nitradoConnId");
