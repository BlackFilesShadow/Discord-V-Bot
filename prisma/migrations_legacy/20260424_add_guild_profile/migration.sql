-- Phase 6: Guild-Awareness Stammdaten
CREATE TABLE IF NOT EXISTS "GuildProfile" (
  "guildId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" TEXT,
  "ownerName" TEXT,
  "memberCount" INTEGER NOT NULL DEFAULT 0,
  "channelCount" INTEGER NOT NULL DEFAULT 0,
  "roleCount" INTEGER NOT NULL DEFAULT 0,
  "iconUrl" TEXT,
  "preferredLocale" TEXT,
  "description" TEXT,
  "features" JSONB,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuildProfile_pkey" PRIMARY KEY ("guildId")
);

CREATE INDEX IF NOT EXISTS "GuildProfile_name_idx" ON "GuildProfile"("name");
