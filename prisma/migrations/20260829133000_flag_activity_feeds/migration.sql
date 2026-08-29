ALTER TYPE "GameplayFeedKind" ADD VALUE IF NOT EXISTS 'FLAG';

DO $$ BEGIN
  CREATE TYPE "FlagActivityAction" AS ENUM ('RAISED', 'LOWERED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "FlagActivityEvent" (
  "id" TEXT NOT NULL,
  "eventKey" VARCHAR(64) NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "sourceFile" TEXT NOT NULL,
  "sourceByteStart" BIGINT NOT NULL,
  "occurredAt" TIMESTAMP(3),
  "action" "FlagActivityAction" NOT NULL,
  "actorGameId" TEXT,
  "actorName" TEXT,
  "actorPosition" TEXT,
  "flagType" TEXT,
  "flagPosition" TEXT,
  "rawLine" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FlagActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FlagActivityEvent_eventKey_key"
  ON "FlagActivityEvent"("eventKey");
CREATE INDEX IF NOT EXISTS "FlagActivityEvent_guildId_nitradoConnId_createdAt_id_idx"
  ON "FlagActivityEvent"("guildId", "nitradoConnId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "FlagActivityEvent_guildId_nitradoConnId_occurredAt_idx"
  ON "FlagActivityEvent"("guildId", "nitradoConnId", "occurredAt");
CREATE INDEX IF NOT EXISTS "FlagActivityEvent_guildId_nitradoConnId_actorGameId_occurredAt_idx"
  ON "FlagActivityEvent"("guildId", "nitradoConnId", "actorGameId", "occurredAt");
