-- Phase 10 (B3 Modell-Check): persistente Provider-Statistik
CREATE TABLE IF NOT EXISTS "AiProviderStat" (
  "id"             TEXT NOT NULL,
  "provider"       TEXT NOT NULL,
  "successCount"   INTEGER NOT NULL DEFAULT 0,
  "failureCount"   INTEGER NOT NULL DEFAULT 0,
  "rateLimitCount" INTEGER NOT NULL DEFAULT 0,
  "totalLatencyMs" BIGINT NOT NULL DEFAULT 0,
  "lastSuccessAt"  TIMESTAMP(3),
  "lastFailureAt"  TIMESTAMP(3),
  "lastError"      TEXT,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderStat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderStat_provider_key" ON "AiProviderStat"("provider");
