-- #293: migrate every legacy BUILD configuration to one semantic class.
-- Pure placement configs are retyped in place. Mixed configs are split while
-- preserving the channel, cursor, settings and all existing PLACEMENT delivery
-- receipts/statuses. This prevents both silent event loss and duplicate replay.

-- 1) Clone only mixed BUILD configs into a dedicated PLACEMENT config.
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
  'placement_' || substr(md5(c."id"), 1, 24),
  c."guildId",
  c."nitradoConnId",
  'PLACEMENT'::"GameplayFeedKind",
  c."channelId",
  c."isActive",
  ARRAY['PLACEMENT']::TEXT[],
  c."showActorCoords",
  false,
  false,
  false,
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
WHERE c."kind" = 'BUILD'::"GameplayFeedKind"
  AND array_position(c."categories", 'PLACEMENT') IS NOT NULL
  AND cardinality(array_remove(c."categories", 'PLACEMENT')) > 0
ON CONFLICT DO NOTHING;

-- 2) Move all historic/open PLACEMENT deliveries of mixed configs to the clone.
-- Their state/messageId/attempt counters remain unchanged, so retry/dedupe
-- semantics survive the migration exactly instead of replaying or dropping them.
UPDATE "GameplayFeedDelivery" d
SET "configId" = 'placement_' || substr(md5(c."id"), 1, 24)
FROM "GameplayFeedConfig" c,
     "AdmEvent" a
WHERE d."configId" = c."id"
  AND a."id" = d."admEventId"
  AND a."guildId" = d."guildId"
  AND a."nitradoConnId" = d."nitradoConnId"
  AND a."eventType" = 'PLACEMENT'
  AND c."kind" = 'BUILD'::"GameplayFeedKind"
  AND array_position(c."categories", 'PLACEMENT') IS NOT NULL
  AND cardinality(array_remove(c."categories", 'PLACEMENT')) > 0;

-- 3) Mixed originals become BUILD/DISMANTLE/DESTROY-only.
UPDATE "GameplayFeedConfig"
SET "categories" = array_remove("categories", 'PLACEMENT')
WHERE "kind" = 'BUILD'::"GameplayFeedKind"
  AND array_position("categories", 'PLACEMENT') IS NOT NULL
  AND cardinality(array_remove("categories", 'PLACEMENT')) > 0;

-- 4) A pure legacy PLACEMENT config keeps its id and delivery history.
UPDATE "GameplayFeedConfig"
SET "kind" = 'PLACEMENT'::"GameplayFeedKind",
    "categories" = ARRAY['PLACEMENT']::TEXT[],
    "showTargetCoords" = false,
    "showTool" = false,
    "showDistance" = false
WHERE "kind" = 'BUILD'::"GameplayFeedKind"
  AND array_position("categories", 'PLACEMENT') IS NOT NULL
  AND cardinality(array_remove("categories", 'PLACEMENT')) = 0;
