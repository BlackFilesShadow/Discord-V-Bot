-- Phase 5: erweitert die bestehende Ready-Notice additiv zu einer retrybaren
-- Discord-Outbox. Bestehende Datensaetze repraesentieren bereits gesendete
-- Nachrichten und werden deshalb als SENT uebernommen.
ALTER TABLE "EconomyMarketOrderReadyNotice"
  ALTER COLUMN "deleteAt" DROP NOT NULL,
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'SENT',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "sentAt" TIMESTAMP(3);

UPDATE "EconomyMarketOrderReadyNotice"
SET "sentAt" = COALESCE("sentAt", "createdAt")
WHERE "messageId" IS NOT NULL;

ALTER TABLE "EconomyMarketOrderReadyNotice"
  ADD CONSTRAINT "EconomyMarketOrderReadyNotice_status_check"
  CHECK ("status" IN ('READY', 'SENDING', 'SENT', 'FAILED'));

CREATE INDEX "EconomyMarketOrderReadyNotice_delivery_idx"
  ON "EconomyMarketOrderReadyNotice"("status", "nextAttemptAt");
