-- Phase 5: erweitert den bestehenden Ready-Notice-Datensatz additiv zu einem
-- retryfaehigen Send-Outbox-Zustand. Bestehende SENT-Zeilen behalten ihre
-- messageId/deleteAt-Semantik; neue PENDING-Zeilen koennen vor dem Discord-Send
-- atomar mit dem Order-Abschluss erzeugt und nach Neustarts erneut versucht werden.
CREATE TYPE "EconomyMarketOrderReadyNoticeStatus" AS ENUM ('PENDING', 'SENDING', 'SENT');

ALTER TABLE "EconomyMarketOrderReadyNotice"
  ADD COLUMN "status" "EconomyMarketOrderReadyNoticeStatus" NOT NULL DEFAULT 'SENT',
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "sentAt" TIMESTAMP(3),
  ALTER COLUMN "channelId" DROP NOT NULL,
  ALTER COLUMN "deleteAt" DROP NOT NULL;

ALTER TABLE "EconomyMarketOrderReadyNotice"
  ADD CONSTRAINT "EconomyMarketOrderReadyNotice_attempts_nonnegative_check" CHECK ("attempts" >= 0);

UPDATE "EconomyMarketOrderReadyNotice"
SET "status"='SENT', "sentAt"=COALESCE("sentAt", "createdAt")
WHERE "messageId" IS NOT NULL;

CREATE INDEX "EconomyMarketOrderReadyNotice_send_due_idx"
  ON "EconomyMarketOrderReadyNotice"("status", "nextAttemptAt", "leaseUntil");