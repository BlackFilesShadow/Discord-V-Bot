-- Migration: Level-Rollen und Level-Up-Nachrichten pro Guild

CREATE TABLE IF NOT EXISTS "LevelRole" (
  "id" SERIAL PRIMARY KEY,
  "guildId" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "roleId" TEXT NOT NULL,
  CONSTRAINT "LevelRole_guildId_level_unique" UNIQUE ("guildId", "level")
);

CREATE TABLE IF NOT EXISTS "LevelUpMessage" (
  "id" SERIAL PRIMARY KEY,
  "guildId" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "message" TEXT NOT NULL,
  CONSTRAINT "LevelUpMessage_guildId_level_unique" UNIQUE ("guildId", "level")
);

-- Indexe für schnelle Suche
CREATE INDEX IF NOT EXISTS "LevelRole_guildId_idx" ON "LevelRole" ("guildId");
CREATE INDEX IF NOT EXISTS "LevelUpMessage_guildId_idx" ON "LevelUpMessage" ("guildId");
