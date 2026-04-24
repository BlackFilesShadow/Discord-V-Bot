-- Index auf TicketMessage.createdAt fuer schnellere Sortierung
-- in groesseren Ticket-Threads.
CREATE INDEX IF NOT EXISTS "TicketMessage_createdAt_idx" ON "TicketMessage"("createdAt");
