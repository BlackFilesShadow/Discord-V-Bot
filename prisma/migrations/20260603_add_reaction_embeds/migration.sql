-- Phase 2: Reaktions-Embeds — SelfRoleMenu/SelfRoleOption additiv erweitern.
-- Deploy + CI nutzen `prisma db push` (schema.prisma ist massgeblich); diese
-- Datei dient der Historie/Konvention. Alle Spalten sind NON-BREAKING mit
-- Default-Werten, damit bestehende Menus unveraendert weiterlaufen.

ALTER TABLE "SelfRoleMenu"
  ADD COLUMN IF NOT EXISTS "embedId" TEXT,
  ADD COLUMN IF NOT EXISTS "componentType" TEXT NOT NULL DEFAULT 'BUTTON',
  ADD COLUMN IF NOT EXISTS "assignMode" TEXT NOT NULL DEFAULT 'TOGGLE',
  ADD COLUMN IF NOT EXISTS "maxRolesPerUser" INTEGER,
  ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SelfRoleOption"
  ADD COLUMN IF NOT EXISTS "buttonStyle" TEXT NOT NULL DEFAULT 'SECONDARY',
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Optionale Verknuepfung zum Embed-Builder; loeschen des Embeds setzt FK auf NULL.
DO $$ BEGIN
  ALTER TABLE "SelfRoleMenu"
    ADD CONSTRAINT "SelfRoleMenu_embedId_fkey"
    FOREIGN KEY ("embedId") REFERENCES "DashboardEmbed"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "SelfRoleMenu_guildId_archived_idx" ON "SelfRoleMenu"("guildId", "archived");
CREATE INDEX IF NOT EXISTS "SelfRoleMenu_embedId_idx" ON "SelfRoleMenu"("embedId");
