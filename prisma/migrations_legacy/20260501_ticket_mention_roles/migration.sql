-- Add mentionRoleIds to TicketTemplate (Postgres text[])
ALTER TABLE "TicketTemplate"
  ADD COLUMN "mentionRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
