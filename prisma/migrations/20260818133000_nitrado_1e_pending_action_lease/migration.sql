-- Nitrado-1E: bestaetigte PendingServerActions duerfen bei Prozessabbruch
-- nicht verloren gehen. RUNNING + Claim-Lease trennt Confirmation von
-- erfolgreichem Abschluss und erlaubt fenced Recovery.

ALTER TABLE "PendingServerAction"
  ADD COLUMN IF NOT EXISTS "claimToken" TEXT,
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);

ALTER TABLE "PendingServerAction"
  DROP CONSTRAINT IF EXISTS "PendingServerAction_status_check";
ALTER TABLE "PendingServerAction"
  ADD CONSTRAINT "PendingServerAction_status_check"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'CONSUMED'));

CREATE INDEX IF NOT EXISTS "PendingServerAction_status_claimedAt_idx"
  ON "PendingServerAction"("status", "claimedAt");
