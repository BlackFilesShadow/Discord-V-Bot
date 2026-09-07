-- Controlled parser-version backfill state. This table deliberately does not
-- touch AdmSourceCursor: historical normalization operates only on persisted
-- AdmEvent rows and must never rewind the remote ADM byte cursor.
CREATE TABLE "AdmParserBackfillState" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "targetParserVersion" INTEGER NOT NULL,
    "processedRows" BIGINT NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmParserBackfillState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdmParserBackfillState_guildId_nitradoConnId_targetParserVersion_key"
    ON "AdmParserBackfillState"("guildId", "nitradoConnId", "targetParserVersion");

CREATE INDEX "AdmParserBackfillState_targetParserVersion_completedAt_idx"
    ON "AdmParserBackfillState"("targetParserVersion", "completedAt");
