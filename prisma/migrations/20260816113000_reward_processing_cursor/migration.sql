-- Durable, monotonic high-watermarks for batched reward streams.
-- No historical reward is granted by this migration; existing rows stay untouched.
CREATE TABLE "RewardProcessingCursor" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "stream" VARCHAR(64) NOT NULL,
    "lastTimestamp" TIMESTAMP(3) NOT NULL,
    "lastEntityId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardProcessingCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RewardProcessingCursor_guildId_nitradoConnId_stream_key"
    ON "RewardProcessingCursor"("guildId", "nitradoConnId", "stream");

CREATE INDEX "RewardProcessingCursor_guildId_nitradoConnId_idx"
    ON "RewardProcessingCursor"("guildId", "nitradoConnId");
