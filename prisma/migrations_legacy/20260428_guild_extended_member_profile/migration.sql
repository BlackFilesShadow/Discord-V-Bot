-- Phase 18: Erweiterte Server-Stammdaten + Per-Guild Member-Profile.
-- Additiv: bestehende Spalten/Indizes bleiben unveraendert.

ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "verificationLevel" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "premiumTier" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "premiumSubscriptionCount" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "vanityUrlCode" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "bannerUrl" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "splashUrl" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "afkChannelName" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "afkTimeoutSec" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "systemChannelName" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "rulesChannelName" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "publicUpdatesChannelName" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "nsfwLevel" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "mfaLevel" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "emojiCount" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "stickerCount" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "isLarge" BOOLEAN;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "botCount" INTEGER;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "topRolesJson" JSONB;

CREATE TABLE IF NOT EXISTS "GuildMemberProfile" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "discordId" TEXT NOT NULL,
  "username" TEXT,
  "nickname" TEXT,
  "joinedAt" TIMESTAMP(3),
  "topRolesJson" JSONB,
  "isBoosting" BOOLEAN NOT NULL DEFAULT false,
  "boostingSince" TIMESTAMP(3),
  "isPending" BOOLEAN NOT NULL DEFAULT false,
  "timeoutUntil" TIMESTAMP(3),
  "isLeft" BOOLEAN NOT NULL DEFAULT false,
  "leftAt" TIMESTAMP(3),
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GuildMemberProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GuildMemberProfile_guildId_discordId_key"
  ON "GuildMemberProfile"("guildId", "discordId");
CREATE INDEX IF NOT EXISTS "GuildMemberProfile_guildId_idx"
  ON "GuildMemberProfile"("guildId");
CREATE INDEX IF NOT EXISTS "GuildMemberProfile_discordId_idx"
  ON "GuildMemberProfile"("discordId");
CREATE INDEX IF NOT EXISTS "GuildMemberProfile_guildId_lastSeenAt_idx"
  ON "GuildMemberProfile"("guildId", "lastSeenAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GuildMemberProfile_guildId_fkey'
  ) THEN
    ALTER TABLE "GuildMemberProfile"
      ADD CONSTRAINT "GuildMemberProfile_guildId_fkey"
      FOREIGN KEY ("guildId") REFERENCES "GuildProfile"("guildId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
