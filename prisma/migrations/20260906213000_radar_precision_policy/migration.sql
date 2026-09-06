-- Radar precision policy migration
--
-- The dashboard no longer owns a global Auto-Ban or configurable altitude band.
-- Punitive intent is encoded by explicit BAN_* function keys. The legacy zone
-- columns remain as internal execution metadata so the proven temporal/snapshot
-- safety machinery can be retained without a destructive schema rewrite.

-- Preserve old punitive intent without ever turning a formerly non-punitive
-- zone into an armed one. PLAYER_DETECTION stays as the non-punitive feed and
-- gets a separate BAN_PLAYER_DETECTION only when the old master Auto-Ban was ON.
INSERT INTO "RadarZoneFunction" ("id", "zoneId", "functionKey")
SELECT 'radar-mig-' || md5(z."id" || ':BAN_PLAYER_DETECTION'), z."id", 'BAN_PLAYER_DETECTION'
FROM "RadarZone" z
JOIN "RadarZoneFunction" f ON f."zoneId" = z."id" AND f."functionKey" = 'PLAYER_DETECTION'
WHERE z."autoBanEnabled" = TRUE
ON CONFLICT ("zoneId", "functionKey") DO NOTHING;

INSERT INTO "RadarZoneFunction" ("id", "zoneId", "functionKey")
SELECT 'radar-mig-' || md5(z."id" || ':' || mapped."newKey"), z."id", mapped."newKey"
FROM "RadarZone" z
JOIN "RadarZoneFunction" f ON f."zoneId" = z."id"
JOIN (VALUES
  ('PLACEMENT', 'BAN_PLACEMENT'),
  ('BUILD', 'BAN_BUILD'),
  ('DISMANTLE', 'BAN_DISMANTLE'),
  ('DESTROY', 'BAN_DESTROY')
) AS mapped("oldKey", "newKey") ON mapped."oldKey" = f."functionKey"
WHERE z."autoBanEnabled" = TRUE
ON CONFLICT ("zoneId", "functionKey") DO NOTHING;

-- Legacy non-player function keys represented monitoring when the old global
-- Auto-Ban switch was OFF. The new product contract has no such monitoring
-- toggles, so deleting them is safer than silently converting them to bans.
DELETE FROM "RadarZoneFunction"
WHERE "functionKey" IN ('PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY');

-- Hidden altitude bands must not survive as invisible policy. Height remains
-- precise ADM evidence on RadarZoneEvent and during revalidation, but no longer
-- acts as a user-configurable vertical zone.
UPDATE "RadarZone"
SET "altitudeEnabled" = FALSE,
    "minAltitudeMeters" = NULL,
    "maxAltitudeMeters" = NULL;

-- Re-arm every zone from the explicit punitive function set. Resetting the
-- generation clock prevents delayed events from the legacy policy becoming
-- punitive under the new one.
UPDATE "RadarZone" z
SET "autoBanEnabled" = EXISTS (
      SELECT 1 FROM "RadarZoneFunction" f
      WHERE f."zoneId" = z."id" AND left(f."functionKey", 4) = 'BAN_'
    ),
    "autoBanEnabledAt" = CASE WHEN EXISTS (
      SELECT 1 FROM "RadarZoneFunction" f
      WHERE f."zoneId" = z."id" AND left(f."functionKey", 4) = 'BAN_'
    ) THEN CURRENT_TIMESTAMP ELSE NULL END,
    "autoBanAuthorizedBy" = CASE WHEN EXISTS (
      SELECT 1 FROM "RadarZoneFunction" f
      WHERE f."zoneId" = z."id" AND left(f."functionKey", 4) = 'BAN_'
    ) THEN COALESCE(z."autoBanAuthorizedBy", z."updatedBy") ELSE NULL END,
    "version" = z."version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP;

-- No pre-migration queued punitive decision may cross the policy boundary.
UPDATE "RadarZoneEvent"
SET "autoBanStatus" = 'SKIPPED',
    "autoBanLeaseUntil" = NULL,
    "autoBanProcessedAt" = CURRENT_TIMESTAMP,
    "autoBanLastError" = 'RADAR_PRECISION_POLICY_MIGRATION_REARMED'
WHERE "autoBanStatus" IN ('PENDING', 'PROCESSING', 'RETRY');

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

  -- Kept for backward-compatible snapshot shape. Vertical filtering is disabled;
  -- the event altitude itself remains immutable evidence and is re-matched by code.
  NEW."zoneAltitudeSnapshot" := jsonb_build_object(
    'enabled', false,
    'minAltitudeMeters', NULL,
    'maxAltitudeMeters', NULL
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

  -- PLAYER_DETECTION and any future non-BAN_* feed are never punitive, even if
  -- the same zone has other ban toggles enabled.
  IF left(NEW."functionKey", 4) <> 'BAN_' THEN
    NEW."autoBanStatus" := 'DISABLED';
  ELSIF NOT z."autoBanEnabled" THEN
    NEW."autoBanStatus" := 'DISABLED';
  ELSIF z."autoBanEnabledAt" IS NULL OR z."autoBanAuthorizedBy" IS NULL THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'AUTOBAN_ARM_METADATA_MISSING';
  ELSIF NOT EXISTS (
    SELECT 1 FROM "RadarZoneFunction" f
    WHERE f."zoneId" = z."id" AND f."functionKey" = NEW."functionKey"
  ) THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'FUNCTION_NOT_ENABLED_AT_EVENT_INSERT';
  ELSIF adm_created_at IS NULL OR adm_occurred_at IS NULL OR adm_event_type IS NULL OR adm_event_type <> NEW."admEventType" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_SOURCE_SCOPE_TYPE_OR_TIME_MISMATCH';
  ELSIF adm_created_at <= z."updatedAt" OR adm_occurred_at <= z."updatedAt" THEN
    NEW."autoBanStatus" := 'SKIPPED';
    NEW."autoBanLastError" := 'ADM_EVENT_PREDATES_ZONE_GENERATION';
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
