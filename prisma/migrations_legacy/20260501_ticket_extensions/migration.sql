-- Ticket-System-Erweiterung: bis zu 5 Welcome-Messages + separater Archiv-Channel
ALTER TABLE "TicketTemplate"
  ADD COLUMN "welcomeMessages" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "archiveChannelId" TEXT;

-- Backfill: bestehenden welcomeText in das erste Element des neuen Arrays uebernehmen
UPDATE "TicketTemplate"
SET "welcomeMessages" = jsonb_build_array("welcomeText")
WHERE "welcomeText" IS NOT NULL AND "welcomeText" <> '';
