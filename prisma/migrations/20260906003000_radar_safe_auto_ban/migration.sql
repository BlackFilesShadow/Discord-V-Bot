CREATE TYPE "RadarAutoBanStatus" AS ENUM ('DISABLED', 'PENDING', 'PROCESSING', 'APPLIED', 'SKIPPED', 'RETRY', 'FAILED');

ALTER TABLE "RadarZone"
  ADD COLUMN "autoBanEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "autoBanEnabledAt" TIMESTAMP(3),
  ADD COLUMN "autoBanAuthorizedBy" VARCHAR(32);

ALTER TABLE "RadarZoneEvent"
  ADD COLUMN "zoneVersionSnapshot" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "zoneMapSnapshot" "RadarMap",
  ADD COLUMN "zoneGeometrySnapshot" JSONB,
  ADD COLUMN "zoneFunctionsSnapshot" JSONB,
  ADD COLUMN "zoneAllowlistSnapshot" JSONB,
  ADD COLUMN "autoBanEnabledSnapshot" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "autoBanEnabledAtSnapshot" TIMESTAMP(3),
  ADD COLUMN "autoBanAuthorizedBy" VARCHAR(32),
  ADD COLUMN "autoBanStatus" "RadarAutoBanStatus" NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN "autoBanAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoBanNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "autoBanLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "autoBanBanId" VARCHAR(32),
  ADD COLUMN "autoBanProcessedAt" TIMESTAMP(3),
  ADD COLUMN "autoBanLastError" TEXT;

CREATE INDEX "RadarZone_guildId_nitradoConnId_autoBanEnabled_idx"
  ON "RadarZone"("guildId", "nitradoConnId", "autoBanEnabled");
CREATE INDEX "RadarZoneEvent_guildId_nitradoConnId_autoBanStatus_autoBanNextAttemptAt_idx"
  ON "RadarZoneEvent"("guildId", "nitradoConnId", "autoBanStatus", "autoBanNextAttemptAt");

-- Immutable evidence snapshot. RadarZoneEvent remains an alert record; this trigger only
-- arms the separate auto-ban worker when both the actual ADM occurrence and its DB insert
-- are newer than the exact moment auto-ban was enabled. A delayed/backlogged old ADM line
-- can therefore never become punitive merely because it was ingested after arming.
CREATE OR REPLACE FUNCTION "snapshot_radar_zone_event_for_auto_ban"()
RETURNS TRIGGER AS $$
DECLARE
  z "RadarZone"%ROWTYPE;
  adm_created_at TIMESTAMP(3);
  adm_occurred_at TIMESTAMP(3);
  adm_event_type "AdmEventType";
BEGIN
  SELECT * INTO z
  FROM "RadarZone"
  WHERE "id" = NEW."zoneId"
    AND "guildId" = NEW."guildId"
    AND "nitradoConnId" = NEW."nitradoConnId";

  IF NOT FOUND THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ZONE_SCOPE_NOT_FOUND_AT_EVENT_INSERT';
    RETURN NEW;
  END IF;

  NEW."zoneVersionSnapshot" := z."version";
  NEW."zoneMapSnapshot" := z."map";
  NEW."autoBanEnabledSnapshot" := z."autoBanEnabled";
  NEW."autoBanEnabledAtSnapshot" := z."autoBanEnabledAt";
  NEW."autoBanAuthorizedBy" := CASE WHEN z."autoBanEnabled" THEN z."autoBanAuthorizedBy" ELSE NULL END;

  NEW."zoneGeometrySnapshot" := CASE
    WHEN z."shape" = 'CIRCLE' THEN jsonb_build_object(
      'shape', 'CIRCLE',
      'centerX', z."centerX",
      'centerY', z."centerY",
      'radiusMeters', z."radiusMeters",
      'minX', z."minX", 'minY', z."minY", 'maxX', z."maxX", 'maxY', z."maxY"
    )
    ELSE jsonb_build_object(
      'shape', 'POLYGON',
      'points', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('x', p."x", 'y', p."y") ORDER BY p."position")
        FROM "RadarZonePoint" p
        WHERE p."zoneId" = z."id"
      ), '[]'::jsonb),
      'minX', z."minX", 'minY', z."minY", 'maxX', z."maxX", 'maxY', z."maxY"
    )
  END;

  NEW."zoneFunctionsSnapshot" := COALESCE((
    SELECT jsonb_agg(f."functionKey" ORDER BY f."functionKey")
    FROM "RadarZoneFunction" f
    WHERE f."zoneId" = z."id"
  ), '[]'::jsonb);

  NEW."zoneAllowlistSnapshot" := COALESCE((
    SELECT jsonb_agg(a."gameId" ORDER BY a."gameId")
    FROM "RadarZoneAllowlist" a
    WHERE a."zoneId" = z."id"
  ), '[]'::jsonb);

  SELECT a."createdAt", a."occurredAt", a."eventType"
    INTO adm_created_at, adm_occurred_at, adm_event_type
  FROM "AdmEvent" a
  WHERE a."id" = NEW."admEventId"
    AND a."guildId" = NEW."guildId"
    AND a."nitradoConnId" = NEW."nitradoConnId";

  IF NOT z."autoBanEnabled" THEN
    NEW."autoBanStatus" := 'DISABLED';
  ELSIF z."autoBanEnabledAt" IS NULL OR z."autoBanAuthorizedBy" IS NULL THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'AUTOBAN_ARM_METADATA_MISSING';
  ELSIF adm_created_at IS NULL OR adm_occurred_at IS NULL OR adm_event_type IS NULL OR adm_event_type <> NEW."admEventType" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_SOURCE_SCOPE_TYPE_OR_TIME_MISMATCH';
  ELSIF adm_created_at <= z."autoBanEnabledAt" OR adm_occurred_at <= z."autoBanEnabledAt" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_EVENT_PREDATES_AUTOBAN_ARM';
  ELSE
    NEW."autoBanStatus" := 'PENDING';
    NEW."autoBanNextAttemptAt" := CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RadarZoneEvent_auto_ban_snapshot"
BEFORE INSERT ON "RadarZoneEvent"
FOR EACH ROW
EXECUTE FUNCTION "snapshot_radar_zone_event_for_auto_ban"();