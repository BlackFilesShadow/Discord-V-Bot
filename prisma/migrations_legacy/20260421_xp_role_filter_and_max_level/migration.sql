-- XP-Rollen-Filter und Max-Level mit Belohnungsrolle
ALTER TABLE "XpConfig" ADD COLUMN IF NOT EXISTS "allowedRoleIds" JSONB;
ALTER TABLE "XpConfig" ADD COLUMN IF NOT EXISTS "maxLevel" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "XpConfig" ADD COLUMN IF NOT EXISTS "maxLevelRoleId" TEXT;
