-- Phase 17: Auto-Translate Scheduled Messages
CREATE TABLE IF NOT EXISTS "TranslatedPost" (
  "id"             TEXT NOT NULL,
  "guildId"        TEXT NOT NULL,
  "channelId"      TEXT NOT NULL,
  "createdBy"      TEXT NOT NULL,
  "sourceText"     TEXT NOT NULL,
  "sourceLang"     TEXT NOT NULL,
  "targetLang"     TEXT NOT NULL,
  "translatedText" TEXT,
  "imageUrl"       TEXT,
  "rolePings"      TEXT,
  "mode"           TEXT NOT NULL,
  "scheduledFor"   TIMESTAMP(3),
  "recurrenceCron" TEXT,
  "nextRunAt"      TIMESTAMP(3),
  "lastRunAt"      TIMESTAMP(3),
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TranslatedPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TranslatedPost_guildId_isActive_idx" ON "TranslatedPost"("guildId", "isActive");
CREATE INDEX IF NOT EXISTS "TranslatedPost_nextRunAt_isActive_idx" ON "TranslatedPost"("nextRunAt", "isActive");
