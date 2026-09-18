-- PAGE 2: persistenter Sollzustand fuer Nitrados eigenen Task-Scheduler.
-- Keine Restarts werden durch V-Bot terminiert; die Tabelle dient nur als
-- restart-sicherer Reconcile-Auftrag fuer echte Nitrado-Tasks.

CREATE TYPE "NitradoRestartPlanMode" AS ENUM ('INTERVAL', 'FIXED');
CREATE TYPE "NitradoRestartPlanSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'ERROR');

CREATE TABLE "NitradoRestartPlan" (
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "nitradoServerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "NitradoRestartPlanMode" NOT NULL DEFAULT 'INTERVAL',
    "intervalHours" INTEGER,
    "startTime" VARCHAR(5),
    "times" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "syncStatus" "NitradoRestartPlanSyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "updatedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoRestartPlan_pkey" PRIMARY KEY ("guildId", "nitradoConnId"),
    CONSTRAINT "NitradoRestartPlan_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "NitradoRestartPlan_interval_check" CHECK ("intervalHours" IS NULL OR "intervalHours" IN (1, 2, 3, 4, 6, 8, 12, 24)),
    CONSTRAINT "NitradoRestartPlan_start_time_check" CHECK ("startTime" IS NULL OR "startTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]);

CREATE INDEX "NitradoRestartPlan_guildId_idx"
    ON "NitradoRestartPlan"("guildId");

CREATE INDEX "NitradoRestartPlan_guildId_syncStatus_idx"
    ON "NitradoRestartPlan"("guildId", "syncStatus");

ALTER TABLE "NitradoRestartPlan"
    ADD CONSTRAINT "NitradoRestartPlan_nitradoConnId_guildId_fkey"
    FOREIGN KEY ("nitradoConnId", "guildId")
    REFERENCES "NitradoConnection"("id", "guildId")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
),
    CONSTRAINT "NitradoRestartPlan_times_check" CHECK (jsonb_typeof("times") = 'array' AND jsonb_array_length("times") <= 24),
    CONSTRAINT "NitradoRestartPlan_shape_check" CHECK (
      ("mode" = 'INTERVAL' AND "intervalHours" IS NOT NULL AND "startTime" IS NOT NULL)
      OR
      ("mode" = 'FIXED' AND "intervalHours" IS NULL AND "startTime" IS NULL)
    )
);

CREATE INDEX "NitradoRestartPlan_guildId_idx"
    ON "NitradoRestartPlan"("guildId");

CREATE INDEX "NitradoRestartPlan_guildId_syncStatus_idx"
    ON "NitradoRestartPlan"("guildId", "syncStatus");

ALTER TABLE "NitradoRestartPlan"
    ADD CONSTRAINT "NitradoRestartPlan_nitradoConnId_guildId_fkey"
    FOREIGN KEY ("nitradoConnId", "guildId")
    REFERENCES "NitradoConnection"("id", "guildId")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
