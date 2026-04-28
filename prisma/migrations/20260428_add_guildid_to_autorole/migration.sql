-- Add guildId to AutoRole for Multi-Guild-Trennung
-- Bestehende Eintraege bleiben mit guildId = NULL und werden von neuen
-- Queries (where: { guildId }) automatisch ausgefiltert (cleaner cut).
ALTER TABLE "AutoRole" ADD COLUMN "guildId" TEXT;
CREATE INDEX "AutoRole_guildId_idx" ON "AutoRole"("guildId");
