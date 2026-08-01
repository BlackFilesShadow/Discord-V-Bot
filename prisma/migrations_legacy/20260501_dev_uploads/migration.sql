-- DEV-Uploads (Phase 2): Per-User isolierte ADM/RPT/XML/JSON-Logs zur Analyse.
-- TTL via expiresAt + Cleanup-Job (siehe src/dashboard/services/devUpload.ts).

CREATE TABLE "DevUpload" (
  "id"            TEXT         NOT NULL,
  "userDiscordId" TEXT         NOT NULL,
  "kind"          VARCHAR(8)   NOT NULL,
  "originalName"  VARCHAR(255) NOT NULL,
  "storedPath"    VARCHAR(512) NOT NULL,
  "mimeType"      VARCHAR(120) NOT NULL,
  "sizeBytes"     INTEGER      NOT NULL,
  "sha256"        VARCHAR(64)  NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "deletedAt"     TIMESTAMP(3),

  CONSTRAINT "DevUpload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DevUpload_userDiscordId_createdAt_idx"
  ON "DevUpload"("userDiscordId", "createdAt");

CREATE INDEX "DevUpload_expiresAt_idx"
  ON "DevUpload"("expiresAt");
