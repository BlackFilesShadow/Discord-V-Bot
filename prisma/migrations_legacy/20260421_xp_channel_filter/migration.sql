-- XP-Kanal-Filter (strikt)
ALTER TABLE "XpConfig" ADD COLUMN IF NOT EXISTS "allowedChannelIds" JSONB;
