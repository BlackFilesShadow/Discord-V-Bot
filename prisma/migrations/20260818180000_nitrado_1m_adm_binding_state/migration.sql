-- Nitrado-1M: preserve the ADM cursor/event namespace across token changes,
-- but advance it whenever a Connection is rebound to a different Nitrado service.
CREATE TABLE "NitradoAdmBindingState" (
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "bindingVersion" INTEGER NOT NULL DEFAULT 0,
    "currentServiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NitradoAdmBindingState_pkey" PRIMARY KEY ("guildId", "nitradoConnId")
);

CREATE INDEX "NitradoAdmBindingState_nitradoConnId_idx"
ON "NitradoAdmBindingState"("nitradoConnId");

-- Existing slots stay on legacy namespace version 0. This is intentionally
-- backfilled before any future service rebind can increment the version.
INSERT INTO "NitradoAdmBindingState" (
    "guildId", "nitradoConnId", "bindingVersion", "currentServiceId", "createdAt", "updatedAt"
)
SELECT
    "guildId", "id", 0, "nitradoServerId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "NitradoConnection"
ON CONFLICT ("guildId", "nitradoConnId") DO NOTHING;
