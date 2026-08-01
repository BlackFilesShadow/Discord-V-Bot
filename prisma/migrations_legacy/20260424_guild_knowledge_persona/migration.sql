-- Phase 8: GuildKnowledge + Persona-Override + AI-Brief
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "aiPersonaOverride" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "aiBrief" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "aiBriefAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "GuildKnowledge" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuildKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GuildKnowledge_guildId_idx" ON "GuildKnowledge"("guildId");
CREATE INDEX IF NOT EXISTS "GuildKnowledge_guildId_isActive_idx" ON "GuildKnowledge"("guildId", "isActive");

-- Foreign Key (best-effort; falls schon vorhanden, wirft DO Block).
DO $$ BEGIN
  ALTER TABLE "GuildKnowledge" ADD CONSTRAINT "GuildKnowledge_guildId_fkey"
    FOREIGN KEY ("guildId") REFERENCES "GuildProfile"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
