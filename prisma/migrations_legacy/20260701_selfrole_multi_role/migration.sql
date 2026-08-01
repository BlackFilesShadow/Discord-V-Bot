-- ProBot-Stil Reaktionsrollen: bis zu 5 Rollen pro Button + personalisierte Bestätigung.
-- Additiv/non-breaking. Deploy + CI nutzen `prisma db push`; diese Migration dient
-- der Historie/Konvention. Idempotent via IF NOT EXISTS.

ALTER TABLE "SelfRoleOption" ADD COLUMN IF NOT EXISTS "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SelfRoleOption" ADD COLUMN IF NOT EXISTS "confirmMessage" VARCHAR(500);
