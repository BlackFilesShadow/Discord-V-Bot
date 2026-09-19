-- The original radar editor projected canonical DayZ Z with the vertical sign
-- reversed. Existing punitive zones may therefore describe the mirrored server
-- location even though the dashboard showed the intended place.
--
-- There is no trustworthy persisted provenance that can distinguish a
-- map-drawn mirrored geometry from a manually entered canonical geometry, so a
-- blind data flip would be unsafe. Pause every pre-fix punitive zone instead.
-- An explicit dashboard save after deployment re-validates the now-correct
-- X/Z geometry, increments the zone generation and arms auto-ban again.

WITH "punitiveZones" AS (
  SELECT DISTINCT z."id"
  FROM "RadarZone" z
  INNER JOIN "RadarZoneFunction" f ON f."zoneId" = z."id"
  WHERE LEFT(f."functionKey", 4) = 'BAN_'
)
UPDATE "RadarZone" z
SET
  "autoBanEnabled" = FALSE,
  "autoBanEnabledAt" = NULL,
  "autoBanAuthorizedBy" = NULL,
  "version" = z."version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE z."id" IN (SELECT "id" FROM "punitiveZones");

-- Retire any not-yet-finalized punitive work from the old coordinate
-- generation. APPLIED bans are intentionally not mutated here: automatically
-- undoing an already enforced moderation action without operator review would
-- be a separate and unsafe policy change.
UPDATE "RadarZoneEvent" e
SET
  "autoBanStatus" = 'SKIPPED',
  "autoBanProcessedAt" = CURRENT_TIMESTAMP,
  "autoBanLeaseUntil" = NULL,
  "autoBanLastError" = 'COORDINATE_ORIENTATION_REVIEW_REQUIRED'
WHERE e."autoBanStatus" IN ('PENDING', 'PROCESSING', 'RETRY')
  AND EXISTS (
    SELECT 1
    FROM "RadarZoneFunction" f
    WHERE f."zoneId" = e."zoneId"
      AND LEFT(f."functionKey", 4) = 'BAN_'
  );
