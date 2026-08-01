-- Add guildId to ModerationCase for Guild-Trennung
ALTER TABLE "ModerationCase" ADD COLUMN "guildId" TEXT;
CREATE INDEX "ModerationCase_guildId_idx" ON "ModerationCase"("guildId");
