-- CreateEnum
CREATE TYPE "WhitelistSyncState" AS ENUM ('LOCAL_ONLY', 'SYNCED', 'PENDING_REMOVE');

-- AlterTable
ALTER TABLE "WhitelistEntry" ADD COLUMN "syncState" "WhitelistSyncState" NOT NULL DEFAULT 'LOCAL_ONLY',
ADD COLUMN "lastSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WhitelistEntry_guildId_nitradoConnId_syncState_idx" ON "WhitelistEntry"("guildId", "nitradoConnId", "syncState");
