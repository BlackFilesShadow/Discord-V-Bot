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

-- Radar player selector needs one latest named session per identity. This
-- additive partial index prevents a full historical PlayerSession sort at 4k+.
CREATE INDEX IF NOT EXISTS "PlayerSession_radar_directory_idx"
ON "PlayerSession" ("guildId", "nitradoConnId", "gameId", "updatedAt" DESC, "id" DESC)
WHERE "playerName" IS NOT NULL;

-- Flag activity correlates PLAYER_POSITION samples for a small candidate set
-- inside a bounded event-time window. This index avoids scanning global ADM
-- history when overall player/sample volume is high.
CREATE INDEX IF NOT EXISTS "AdmEvent_flag_activity_position_idx"
ON "AdmEvent" ("guildId", "nitradoConnId", "eventType", "actorGameId", "occurredAt")
WHERE "actorPosition" IS NOT NULL AND "occurredAt" IS NOT NULL;

