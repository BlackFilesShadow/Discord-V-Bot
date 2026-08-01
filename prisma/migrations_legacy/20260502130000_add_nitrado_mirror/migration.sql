-- CreateEnum
CREATE TYPE "NitradoSnapshotStatus" AS ENUM ('RUNNING', 'OK', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "NitradoSnapshot" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "serviceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "NitradoSnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalDirs" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "storedBytes" BIGINT NOT NULL DEFAULT 0,
    "oversizeFiles" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "settingsJson" JSONB,
    "serviceMetaJson" JSONB,

    CONSTRAINT "NitradoSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NitradoSnapshotFile" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "name" VARCHAR(512) NOT NULL,
    "parentDir" VARCHAR(1024) NOT NULL,
    "isDir" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "modifiedAt" TIMESTAMP(3),
    "sha256" VARCHAR(64),
    "mimeGuess" VARCHAR(120),
    "isText" BOOLEAN NOT NULL DEFAULT false,
    "contentText" TEXT,
    "storedPath" VARCHAR(512),
    "oversize" BOOLEAN NOT NULL DEFAULT false,
    "errorMsg" TEXT,

    CONSTRAINT "NitradoSnapshotFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NitradoSnapshot_guildId_nitradoConnId_startedAt_idx" ON "NitradoSnapshot"("guildId", "nitradoConnId", "startedAt");

-- CreateIndex
CREATE INDEX "NitradoSnapshot_nitradoConnId_status_idx" ON "NitradoSnapshot"("nitradoConnId", "status");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_parentDir_idx" ON "NitradoSnapshotFile"("snapshotId", "parentDir");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_name_idx" ON "NitradoSnapshotFile"("snapshotId", "name");

-- CreateIndex
CREATE INDEX "NitradoSnapshotFile_snapshotId_sha256_idx" ON "NitradoSnapshotFile"("snapshotId", "sha256");

-- AddForeignKey
ALTER TABLE "NitradoSnapshot" ADD CONSTRAINT "NitradoSnapshot_nitradoConnId_fkey" FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NitradoSnapshotFile" ADD CONSTRAINT "NitradoSnapshotFile_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "NitradoSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
