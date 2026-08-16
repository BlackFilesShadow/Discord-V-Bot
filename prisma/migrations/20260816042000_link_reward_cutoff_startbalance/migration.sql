-- Reward-/Startguthaben-Semantik ab Account-Verknuepfung.
--
-- Bestehende VERIFIED-Links werden bewusst auf den Deploy-/Migrationszeitpunkt
-- gebaselined. Dadurch kann nach dem Rollout weder alte unverlinkte Spielzeit
-- noch ein altes ADM-Ereignis nachtraeglich Guthaben erzeugen.

CREATE TABLE "EconomyLinkRewardState" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "identityHash" VARCHAR(64) NOT NULL,
    "rewardEligibleFrom" TIMESTAMP(3) NOT NULL,
    "unlinkedAt" TIMESTAMP(3),
    "startBalanceEligible" BOOLEAN NOT NULL DEFAULT true,
    "startBalanceGrantedAt" TIMESTAMP(3),
    "startBalanceGrantedAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EconomyLinkRewardState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EconomyLinkRewardState_guildId_nitradoConnId_userDiscordId_key"
ON "EconomyLinkRewardState"("guildId", "nitradoConnId", "userDiscordId");
CREATE INDEX "EconomyLinkRewardState_guildId_nitradoConnId_identityHash_idx"
ON "EconomyLinkRewardState"("guildId", "nitradoConnId", "identityHash");
CREATE INDEX "EconomyLinkRewardState_guildId_nitradoConnId_unlinkedAt_idx"
ON "EconomyLinkRewardState"("guildId", "nitradoConnId", "unlinkedAt");

CREATE TABLE "PlaytimeRewardProgress" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "rewardEpoch" TIMESTAMP(3) NOT NULL,
    "bucketsCredited" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlaytimeRewardProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlaytimeRewardProgress_sessionId_rewardEpoch_key"
ON "PlaytimeRewardProgress"("sessionId", "rewardEpoch");
CREATE INDEX "PlaytimeRewardProgress_guildId_nitradoConnId_userDiscordId_idx"
ON "PlaytimeRewardProgress"("guildId", "nitradoConnId", "userDiscordId");

-- Historische Links bleiben fuer Anzeige/Audit unveraendert in verifiedAt.
-- Nur der neue Reward-Cutoff startet jetzt. Bestehende Links erhalten bewusst
-- KEIN neues Startguthaben durch blosses erneutes /link. Bereits nach altem
-- System erhaltenes Startguthaben wird fuer Audit/Anzeige mit uebernommen.
INSERT INTO "EconomyLinkRewardState" (
    "id", "guildId", "nitradoConnId", "userDiscordId", "identityHash",
    "rewardEligibleFrom", "unlinkedAt", "startBalanceEligible",
    "startBalanceGrantedAt", "startBalanceGrantedAmount", "createdAt", "updatedAt"
)
SELECT
    CONCAT('legacy_', md5(g."guildId" || ':' || g."nitradoConnId" || ':' || g."userDiscordId")),
    g."guildId",
    g."nitradoConnId",
    g."userDiscordId",
    g."identityHash",
    CURRENT_TIMESTAMP,
    NULL,
    false,
    sb."createdAt",
    COALESCE(sb."delta", 0),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "GameIdentityLink" g
LEFT JOIN LATERAL (
    SELECT t."createdAt", t."delta"
    FROM "EconomyTransaction" t
    WHERE t."guildId" = g."guildId"
      AND t."nitradoConnId" = g."nitradoConnId"
      AND t."userDiscordId" = g."userDiscordId"
      AND t."type" = 'STARTBALANCE_JOIN'
      AND t."delta" > 0
    ORDER BY t."createdAt" ASC
    LIMIT 1
) sb ON TRUE
WHERE g."status" = 'VERIFIED'
  AND g."identityHash" IS NOT NULL
  AND g."nitradoConnId" IS NOT NULL
ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING;

-- Alle vor diesem Cutoff noch offenen ADM-Entscheidungen gehoeren zur alten
-- Reward-Epoche. Sie duerfen nach der Migration nicht als Backpay in die neue
-- linkbasierte Economy rutschen. Bereits PAID Entscheidungen bleiben unveraendert.
UPDATE "RewardDecision"
SET "status" = 'SKIPPED'::"RewardDecisionStatus",
    "reasonCode" = 'SKIPPED_PRE_LINK_CUTOFF_MIGRATION',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('PENDING'::"RewardDecisionStatus", 'FAILED_RETRYABLE'::"RewardDecisionStatus")
  AND "paid" = 0;
