-- Phase 7: GuildProfile Channels/Rules Snapshot
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "channelsJson" JSONB;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "rulesText" TEXT;
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "contentSyncedAt" TIMESTAMP(3);
