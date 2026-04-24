-- Phase 9 (RAG): Embedding-Cache fuer GuildKnowledge.
-- Additiv: alle Spalten optional, kein Default-Backfill noetig.
ALTER TABLE "GuildKnowledge" ADD COLUMN IF NOT EXISTS "embedding" TEXT;
ALTER TABLE "GuildKnowledge" ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT;
ALTER TABLE "GuildKnowledge" ADD COLUMN IF NOT EXISTS "embeddedAt" TIMESTAMP(3);

-- Optional: pgvector-Extension aktivieren, falls verfuegbar. Ignoriert Fehler wenn nicht installiert.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    -- pgvector nicht installiert -- JS-Fallback wird automatisch verwendet
    NULL;
  END;
END $$;
