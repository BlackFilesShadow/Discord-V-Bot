-- Split the historical mixed DEATH kind into first-class KILL (PvP only)
-- and DEATH (non-PvP deaths). Existing delivery receipts are moved instead of
-- replayed so Discord nonce/idempotency history remains intact.

-- 1) Clone every mixed DEATH config that contains PVP plus non-PvP categories.
INSERT INTO "GameplayFeedConfig" (
  "id", "guildId", "nitradoConnId", "kind", "channelId", "isActive",
  "categories", "showActorCoords", "showTargetCoords", "showTool",
  "showDistance", "embedColor", "legacyKillfeedConfigId",
  "cursorCreatedAt", "cursorEventId", "nextDeliveryAt", "lastMessageId",
  "lastStateHash", "lastPlayerCount", "lastPlayerListAt",
  "playerListIntervalMinutes", "nextPlayerListPostAt", "lastEventAt",
  "lastPolledAt", "lastErrorMsg", "createdAt", "updatedAt"
)
SELECT
  'kill_' || substr(md5(c."id"), 1, 24),
  c."guildId",
  c."nitradoConnId",
  'KILL'::"GameplayFeedKind",
  c."channelId",
  c."isActive",
  ARRAY['PVP']::TEXT[],
  c."showActorCoords",
  c."showTargetCoords",
  c."showTool",
  c."showDistance",
  c."embedColor",
  NULL,
  c."cursorCreatedAt",
  c."cursorEventId",
  c."nextDeliveryAt",
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  c."lastEventAt",
  c."lastPolledAt",
  c."lastErrorMsg",
  c."createdAt",
  c."updatedAt"
FROM "GameplayFeedConfig" c
WHERE c."kind" = 'DEATH'::"GameplayFeedKind"
  AND array_position(c."categories", 'PVP') IS NOT NULL
  AND cardinality(array_remove(c."categories", 'PVP')) > 0
ON CONFLICT DO NOTHING;

-- 2) Move all existing PvP delivery state of mixed configs to the KILL clone.
UPDATE "GameplayFeedDelivery" d
SET "configId" = 'kill_' || substr(md5(c."id"), 1, 24)
FROM "GameplayFeedConfig" c,
     "AdmEvent" a
WHERE d."configId" = c."id"
  AND a."id" = d."admEventId"
  AND a."guildId" = d."guildId"
  AND a."nitradoConnId" = d."nitradoConnId"
  AND a."eventType" = 'PLAYER_KILLED'
  AND c."kind" = 'DEATH'::"GameplayFeedKind"
  AND array_position(c."categories", 'PVP') IS NOT NULL
  AND cardinality(array_remove(c."categories", 'PVP')) > 0;

-- 3) Mixed originals become non-PvP Deathfeed configs.
UPDATE "GameplayFeedConfig"
SET "categories" = array_remove("categories", 'PVP')
WHERE "kind" = 'DEATH'::"GameplayFeedKind"
  AND array_position("categories", 'PVP') IS NOT NULL
  AND cardinality(array_remove("categories", 'PVP')) > 0;

-- 4) A pure historical PvP config keeps its id and complete delivery history.
UPDATE "GameplayFeedConfig"
SET "kind" = 'KILL'::"GameplayFeedKind",
    "categories" = ARRAY['PVP']::TEXT[]
WHERE "kind" = 'DEATH'::"GameplayFeedKind"
  AND array_position("categories", 'PVP') IS NOT NULL
  AND cardinality(array_remove("categories", 'PVP')) = 0;

-- 5) Existing full non-PvP Deathfeeds learn the newly deliverable OTHER class.
-- Narrow custom configs (e.g. suicide-only) are deliberately not broadened.
UPDATE "GameplayFeedConfig"
SET "categories" = array_append("categories", 'OTHER')
WHERE "kind" = 'DEATH'::"GameplayFeedKind"
  AND array_position("categories", 'SUICIDE') IS NOT NULL
  AND array_position("categories", 'NPC') IS NOT NULL
  AND array_position("categories", 'VEHICLE') IS NOT NULL
  AND array_position("categories", 'OTHER') IS NULL;
