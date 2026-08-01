-- Phase 17a (Guild-Daten-Fix): Server-Erstellungsdatum von Discord persistieren.
ALTER TABLE "GuildProfile" ADD COLUMN IF NOT EXISTS "serverCreatedAt" TIMESTAMP(3);
