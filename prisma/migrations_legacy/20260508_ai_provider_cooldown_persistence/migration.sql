-- P0-Hardening: Persistente AI-Provider-Cooldowns (ueberlebt Restart + Multi-Replica).
-- Bei 429 wird der Provider in DB markiert; isOnCooldown()/markRateLimited()
-- nutzen die DB als Source-of-Truth, in-memory Map ist nur noch Best-Effort-Cache.

ALTER TABLE "AiProviderStat"
  ADD COLUMN IF NOT EXISTS "cooldownUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cooldownReason" TEXT,
  ADD COLUMN IF NOT EXISTS "cooldownStreak" INTEGER NOT NULL DEFAULT 0;

-- Lookup auf "Welche Provider sind aktuell auf Cooldown" — partial Index hilft
-- bei wenigen aktiven Cooldowns.
CREATE INDEX IF NOT EXISTS "AiProviderStat_cooldownUntil_idx"
  ON "AiProviderStat" ("cooldownUntil")
  WHERE "cooldownUntil" IS NOT NULL;
