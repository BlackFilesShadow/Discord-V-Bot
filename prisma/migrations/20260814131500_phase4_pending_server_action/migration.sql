-- Phase 4 / SCOPE-003
-- Persistiert servergescopte, kurzlebige One-Shot-Aktionen.
-- Keine bestehende Nutzerdatenmigration notwendig: rein additive Tabelle.

CREATE TABLE IF NOT EXISTS "PendingServerAction" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "actorDiscordId" TEXT NOT NULL,
  "actionType" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingServerAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PendingServerAction_guildId_actorDiscordId_status_expiresAt_idx"
  ON "PendingServerAction"("guildId", "actorDiscordId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "PendingServerAction_guildId_nitradoConnId_status_expiresAt_idx"
  ON "PendingServerAction"("guildId", "nitradoConnId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "PendingServerAction_expiresAt_idx"
  ON "PendingServerAction"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'PendingServerAction_nitradoConnId_fkey'
       AND conrelid = '"PendingServerAction"'::regclass
  ) THEN
    ALTER TABLE "PendingServerAction"
      ADD CONSTRAINT "PendingServerAction_nitradoConnId_fkey"
      FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "PendingServerAction"
  DROP CONSTRAINT IF EXISTS "PendingServerAction_status_check";
ALTER TABLE "PendingServerAction"
  ADD CONSTRAINT "PendingServerAction_status_check"
  CHECK ("status" IN ('PENDING', 'CONSUMED'));
