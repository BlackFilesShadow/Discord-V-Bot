-- The pinned Bohemia basemaps are north-oriented: image top is DayZ Z=max.
-- Earlier dashboard code bound image top to Z=0. Existing zone geometry is
-- therefore ambiguous without its original editor interaction and must never
-- keep producing alerts or punitive decisions after the frame correction.

ALTER TABLE "RadarZone"
  ADD COLUMN "coordinateFrameVersion" INTEGER NOT NULL DEFAULT 1;

-- Do not attempt a blanket Z reflection. API-created/manual zones cannot be
-- distinguished from zones created through the old mirrored editor. Require a
-- deliberate visual review in the corrected editor before any legacy zone is
-- active again; route saves mark reviewed zones as frame version 2.
UPDATE "RadarZone"
SET "isActive" = FALSE,
    "autoBanEnabled" = FALSE,
    "autoBanEnabledAt" = NULL,
    "autoBanAuthorizedBy" = NULL,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "coordinateFrameVersion" = 1;

-- A queued decision may contain a pre-correction geometry snapshot. It must
-- not cross the coordinate-frame boundary, even if a worker claims it later.
UPDATE "RadarZoneEvent" e
SET "autoBanStatus" = 'SKIPPED',
    "autoBanLeaseUntil" = NULL,
    "autoBanProcessedAt" = CURRENT_TIMESTAMP,
    "autoBanLastError" = 'RADAR_COORDINATE_FRAME_REVIEW_REQUIRED'
FROM "RadarZone" z
WHERE z."id" = e."zoneId"
  AND z."coordinateFrameVersion" = 1
  AND e."autoBanStatus" IN ('PENDING', 'PROCESSING', 'RETRY');

ALTER TABLE "RadarZone"
  ALTER COLUMN "coordinateFrameVersion" SET DEFAULT 2;

CREATE INDEX "RadarZone_configId_map_isActive_coordinateFrameVersion_idx"
  ON "RadarZone"("configId", "map", "isActive", "coordinateFrameVersion");
