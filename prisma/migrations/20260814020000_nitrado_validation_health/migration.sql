-- NIT-001: persistenter Diagnosezustand fuer wiederholte Nitrado-Tokenfehler.
-- Rein additiv: keine bestehende Connection oder Tokenzeile wird veraendert.

CREATE TABLE "NitradoValidationHealth" (
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastErrorMessage" TEXT,
  "lastFailureAt" TIMESTAMP(3),
  "lastAlertAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NitradoValidationHealth_pkey" PRIMARY KEY ("guildId", "nitradoConnId")
);

CREATE INDEX "NitradoValidationHealth_nitradoConnId_idx"
  ON "NitradoValidationHealth"("nitradoConnId");
