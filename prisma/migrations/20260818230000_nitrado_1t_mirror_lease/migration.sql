CREATE TABLE "NitradoMirrorLease" (
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "bindingKey" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoMirrorLease_pkey" PRIMARY KEY ("guildId","nitradoConnId")
);

CREATE INDEX "NitradoMirrorLease_snapshotId_idx" ON "NitradoMirrorLease"("snapshotId");
CREATE INDEX "NitradoMirrorLease_leaseExpiresAt_idx" ON "NitradoMirrorLease"("leaseExpiresAt");
