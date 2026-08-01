-- Phase 7 KEEP: Auto-Start-Schalter pro Slot (nie aus suspended).
ALTER TABLE "NitradoConnection" ADD COLUMN "keepOnlineEnabled" BOOLEAN NOT NULL DEFAULT false;
