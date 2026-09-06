ALTER TABLE "RadarZone"
  ADD COLUMN "altitudeEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "minAltitudeMeters" DECIMAL(12,3),
  ADD COLUMN "maxAltitudeMeters" DECIMAL(12,3);

ALTER TABLE "RadarZoneEvent"
  ADD COLUMN "zoneAltitudeSnapshot" JSONB;

-- Every saved RadarZone row already carries an @updatedAt timestamp. That timestamp is
-- the effective beginning of the current evaluation generation. A delayed ADM event
-- that happened or was persisted before that generation must never be interpreted
-- against the newer zone state for punitive decisions.
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

  NEW."zoneAltitudeSnapshot" := jsonb_build_object(
    'enabled', z."altitudeEnabled",
    'minAltitudeMeters', z."minAltitudeMeters",
    'maxAltitudeMeters', z."maxAltitudeMeters"
  );

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
  ELSIF adm_created_at <= z."updatedAt" OR adm_occurred_at <= z."updatedAt" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_EVENT_PREDATES_ZONE_GENERATION';
  ELSIF adm_created_at <= z."autoBanEnabledAt" OR adm_occurred_at <= z."autoBanEnabledAt" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_EVENT_PREDATES_AUTOBAN_ARM';
  ELSIF z."altitudeEnabled" AND NEW."altitude" IS NULL THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ALTITUDE_REQUIRED_BY_ZONE';
  ELSE
    NEW."autoBanStatus" := 'PENDING';
    NEW."autoBanNextAttemptAt" := CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
