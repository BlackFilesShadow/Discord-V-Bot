-- Faction-System-Erweiterung: Beschreibung, Farbe, Stellvertretung, expliziter Status,
-- flagUrl wird optional (Upload-Support).
ALTER TABLE "Faction"
  ADD COLUMN "description"      TEXT,
  ADD COLUMN "color"             VARCHAR(7),
  ADD COLUMN "deputyDiscordId"   TEXT,
  ADD COLUMN "status"            VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Faction" ALTER COLUMN "flagUrl" DROP NOT NULL;

-- Backfill: bestehende inaktive Fraktionen bekommen Status INACTIVE
UPDATE "Faction" SET "status" = 'INACTIVE' WHERE "isActive" = false;
