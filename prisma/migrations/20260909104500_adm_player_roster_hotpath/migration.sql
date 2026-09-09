-- Bound PLAYER_LIST evidence lookup by identity instead of active-file history.
-- Partial indexes keep write amplification limited to the two relevant event classes.
CREATE INDEX IF NOT EXISTS "AdmEvent_roster_presence_latest_idx"
ON "AdmEvent" ("guildId", "nitradoConnId", "sourceFile", "actorGameId", "sourceByteStart" DESC, "id" DESC)
WHERE "actorGameId" IS NOT NULL
  AND "eventType" IN ('PLAYER_CONNECTED', 'PLAYER_DISCONNECTED');

CREATE INDEX IF NOT EXISTS "AdmEvent_roster_position_latest_idx"
ON "AdmEvent" ("guildId", "nitradoConnId", "sourceFile", "actorGameId", "sourceByteStart" DESC, "id" DESC)
WHERE "actorGameId" IS NOT NULL
  AND "actorPosition" IS NOT NULL
  AND "eventType" = 'PLAYER_POSITION';
