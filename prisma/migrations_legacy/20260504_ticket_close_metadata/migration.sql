-- Phase: Ticket-Close-Metadaten + persistierte Transcripts (HTML/MD).
-- Erweitert TicketInstance um Felder fuer schoene Close-Embeds und die
-- public Web-Transcript-Ansicht (/transcripts/<id>, KEINE Auth).
-- Idempotent (IF NOT EXISTS), damit Re-Apply nicht crasht.

ALTER TABLE "TicketInstance"
  ADD COLUMN IF NOT EXISTS "closedByName"        TEXT,
  ADD COLUMN IF NOT EXISTS "closeReason"         TEXT,
  ADD COLUMN IF NOT EXISTS "claimedBy"           TEXT,
  ADD COLUMN IF NOT EXISTS "claimedByName"       TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "transcriptText"      TEXT,
  ADD COLUMN IF NOT EXISTS "transcriptHtml"      TEXT,
  ADD COLUMN IF NOT EXISTS "transcriptCreatedAt" TIMESTAMP(3);
