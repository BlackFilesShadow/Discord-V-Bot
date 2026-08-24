-- Preserve archived ticket instances when a TicketTemplate is deleted.
-- Closed ticket transcripts are historical records and must never cascade away.

ALTER TABLE "TicketInstance"
  ADD COLUMN "templateLabelSnapshot" TEXT,
  ADD COLUMN "templateSlotSnapshot" INTEGER;

UPDATE "TicketInstance" AS i
SET "templateLabelSnapshot" = t."label",
    "templateSlotSnapshot" = t."slot"
FROM "TicketTemplate" AS t
WHERE i."templateId" = t."id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TicketInstance"
    WHERE "templateLabelSnapshot" IS NULL OR "templateSlotSnapshot" IS NULL
  ) THEN
    RAISE EXCEPTION 'ticket archive migration aborted: template snapshot backfill incomplete';
  END IF;
END $$;

ALTER TABLE "TicketInstance"
  ALTER COLUMN "templateLabelSnapshot" SET NOT NULL,
  ALTER COLUMN "templateSlotSnapshot" SET NOT NULL,
  ALTER COLUMN "templateId" DROP NOT NULL;

ALTER TABLE "TicketInstance" DROP CONSTRAINT IF EXISTS "TicketInstance_templateId_fkey";
ALTER TABLE "TicketInstance" DROP CONSTRAINT IF EXISTS "TicketInstance_template_guild_fkey";

-- Keep guildId intact when the parent disappears; only templateId is nulled.
ALTER TABLE "TicketInstance" ADD CONSTRAINT "TicketInstance_template_guild_fkey"
  FOREIGN KEY ("templateId", "guildId")
  REFERENCES "TicketTemplate"("id", "guildId")
  ON DELETE SET NULL ("templateId")
  ON UPDATE CASCADE;
