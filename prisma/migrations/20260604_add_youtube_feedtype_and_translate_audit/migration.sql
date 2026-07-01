-- Phase 3: Feed + Übersetzungen ins Dashboard.
-- Additive Enum-Erweiterungen. Deploy + CI nutzen `prisma db push`; diese
-- Migration dient der Historie/Konvention. Idempotent via IF NOT EXISTS.

ALTER TYPE "FeedType" ADD VALUE IF NOT EXISTS 'YOUTUBE';
ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'TRANSLATE';
