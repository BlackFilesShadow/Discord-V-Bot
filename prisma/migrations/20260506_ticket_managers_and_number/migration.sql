-- Stufe 2: Tickets — Manager-Rollen (Multi-Role) + fortlaufende Ticket-Nummer

-- 1) TicketTemplate: managerRoleIds[]
ALTER TABLE "TicketTemplate"
  ADD COLUMN IF NOT EXISTS "managerRoleIds" TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

-- 2) TicketInstance: ticketNumber (auto-increment, unique)
-- Sequence anlegen, dann Spalte hinzufuegen, Backfill, Default & UNIQUE setzen.
CREATE SEQUENCE IF NOT EXISTS "TicketInstance_ticketNumber_seq" START 1;

ALTER TABLE "TicketInstance"
  ADD COLUMN IF NOT EXISTS "ticketNumber" INTEGER;

-- Backfill nach openedAt-Reihenfolge fuer bestehende Tickets.
DO $$
DECLARE
  rec RECORD;
  n INTEGER := 0;
BEGIN
  FOR rec IN SELECT id FROM "TicketInstance" WHERE "ticketNumber" IS NULL ORDER BY "openedAt" ASC, id ASC LOOP
    n := n + 1;
    UPDATE "TicketInstance" SET "ticketNumber" = n WHERE id = rec.id;
  END LOOP;
  -- Sequence auf naechsten freien Wert setzen.
  PERFORM setval('"TicketInstance_ticketNumber_seq"', GREATEST(n, 1), n > 0);
END $$;

ALTER TABLE "TicketInstance"
  ALTER COLUMN "ticketNumber" SET NOT NULL,
  ALTER COLUMN "ticketNumber" SET DEFAULT nextval('"TicketInstance_ticketNumber_seq"');

ALTER SEQUENCE "TicketInstance_ticketNumber_seq" OWNED BY "TicketInstance"."ticketNumber";

CREATE UNIQUE INDEX IF NOT EXISTS "TicketInstance_ticketNumber_key" ON "TicketInstance"("ticketNumber");
