-- Per-Template Ticket-Counter
ALTER TABLE "TicketTemplate"
  ADD COLUMN "ticketCounter" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TicketInstance"
  ADD COLUMN "templateNumber" INTEGER;

CREATE INDEX "TicketInstance_templateId_templateNumber_idx"
  ON "TicketInstance"("templateId", "templateNumber");
