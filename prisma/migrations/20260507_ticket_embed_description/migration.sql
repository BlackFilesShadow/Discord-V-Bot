-- Add optional embedDescription column to TicketTemplate.
-- Erlaubt es, den Beschreibungs-Text des oeffentlichen Open-Embeds pro Template
-- frei zu konfigurieren. NULL/leer => Bot rendert den Default-Text.
ALTER TABLE "TicketTemplate"
  ADD COLUMN IF NOT EXISTS "embedDescription" TEXT;
