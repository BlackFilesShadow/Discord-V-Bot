-- Repair legacy production schemas that adopted the consolidated baseline
-- before the atomic idempotency migration had been applied.

DO $$
BEGIN
  CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'DONE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "IdempotencyKey"
  ADD COLUMN IF NOT EXISTS "status" "IdempotencyStatus" NOT NULL DEFAULT 'DONE';

ALTER TABLE "IdempotencyKey"
  ALTER COLUMN "responseBody" DROP NOT NULL;

ALTER TABLE "IdempotencyKey"
  ALTER COLUMN "responseStatus" DROP NOT NULL;
