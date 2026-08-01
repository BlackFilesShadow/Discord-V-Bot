-- F-004: Atomarer Claim fuer Idempotenz (PROCESSING/DONE).
-- Bestehende Zeilen sind abgeschlossene Antworten -> Default DONE.
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'DONE');

ALTER TABLE "IdempotencyKey"
  ADD COLUMN "status" "IdempotencyStatus" NOT NULL DEFAULT 'DONE';

ALTER TABLE "IdempotencyKey" ALTER COLUMN "responseBody" DROP NOT NULL;
ALTER TABLE "IdempotencyKey" ALTER COLUMN "responseStatus" DROP NOT NULL;
