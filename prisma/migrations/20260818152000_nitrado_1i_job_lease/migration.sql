-- Nitrado-1I: durable worker ownership for RUNNING NitradoJob rows.
CREATE TABLE "NitradoJobLease" (
    "jobId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NitradoJobLease_pkey" PRIMARY KEY ("jobId")
);

CREATE UNIQUE INDEX "NitradoJobLease_claimToken_key" ON "NitradoJobLease"("claimToken");
CREATE INDEX "NitradoJobLease_heartbeatAt_idx" ON "NitradoJobLease"("heartbeatAt");
CREATE INDEX "NitradoJobLease_guildId_heartbeatAt_idx" ON "NitradoJobLease"("guildId", "heartbeatAt");

ALTER TABLE "NitradoJobLease"
ADD CONSTRAINT "NitradoJobLease_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "NitradoJob"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
