-- ADM / Gameplay-Feed Runtime Hygiene
--
-- 1) Bekannte, absichtlich nicht weiterverarbeitete DayZ-Rauschzeilen werden
--    nicht mehr als echte Parser-Unbekannte behandelt. Die Rohzeile bleibt
--    vollstaendig in AdmEvent erhalten; nur parseStatus wird auf IGNORED gesetzt.
-- 2) Gameplay-Feeds an nicht mehr aktiven Nitrado-Verbindungen werden
--    deaktiviert. Offene Zustellungen werden SKIPPED statt als ewiges
--    PENDING/RETRY liegen gelassen.
-- 3) Ein Trigger verhindert, dass derselbe stale Feed-Zustand bei einer
--    spaeteren ACTIVE -> EXPIRED/DISABLED-Statusaenderung erneut entsteht.

CREATE OR REPLACE FUNCTION "vbot_normalize_known_adm_noise"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."eventType" = 'UNKNOWN'
     AND NEW."rawLine" LIKE 'Player "%'
     AND (
       NEW."rawLine" LIKE '%) is connecting'
       OR NEW."rawLine" LIKE '%) performed Emote%'
     )
  THEN
    NEW."parseStatus" := 'IGNORED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "AdmEvent_known_noise_parse_status_trg" ON "AdmEvent";
CREATE TRIGGER "AdmEvent_known_noise_parse_status_trg"
BEFORE INSERT OR UPDATE OF "eventType", "rawLine", "parseStatus"
ON "AdmEvent"
FOR EACH ROW
EXECUTE FUNCTION "vbot_normalize_known_adm_noise"();

-- Bestehende bekannte Noise-Zeilen einmalig normalisieren.
UPDATE "AdmEvent"
SET "parseStatus" = 'IGNORED'
WHERE "eventType" = 'UNKNOWN'
  AND "rawLine" LIKE 'Player "%'
  AND (
    "rawLine" LIKE '%) is connecting'
    OR "rawLine" LIKE '%) performed Emote%'
  )
  AND "parseStatus" IS DISTINCT FROM 'IGNORED';

-- Vor der Deaktivierung offene Zustellungen der betroffenen Configs neutral
-- abschliessen. So bleibt nach dem Deploy kein unsichtbarer Queue-Stau uebrig.
UPDATE "GameplayFeedDelivery"
SET
  "status" = 'SKIPPED',
  "leaseUntil" = NULL,
  "lastError" = 'Skipped: linked Nitrado connection is not active',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "configId" IN (
  SELECT f."id"
  FROM "GameplayFeedConfig" f
  LEFT JOIN "NitradoConnection" n
    ON n."id" = f."nitradoConnId"
   AND n."guildId" = f."guildId"
  WHERE f."isActive" = TRUE
    AND (n."id" IS NULL OR n."status" <> 'ACTIVE')
)
AND "status" IN ('PENDING', 'RETRY', 'SENDING');

UPDATE "GameplayFeedConfig" AS f
SET
  "isActive" = FALSE,
  "lastErrorMsg" = 'Automatisch deaktiviert: Nitrado-Verbindung nicht aktiv/gebunden',
  "lastPolledAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE f."isActive" = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM "NitradoConnection" n
    WHERE n."id" = f."nitradoConnId"
      AND n."guildId" = f."guildId"
      AND n."status" = 'ACTIVE'
  );

CREATE OR REPLACE FUNCTION "vbot_disable_gameplay_feeds_for_inactive_nitrado"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    UPDATE "GameplayFeedDelivery"
    SET
      "status" = 'SKIPPED',
      "leaseUntil" = NULL,
      "lastError" = 'Skipped: linked Nitrado connection became inactive',
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "configId" IN (
      SELECT "id"
      FROM "GameplayFeedConfig"
      WHERE "guildId" = NEW."guildId"
        AND "nitradoConnId" = NEW."id"
        AND "isActive" = TRUE
    )
    AND "status" IN ('PENDING', 'RETRY', 'SENDING');

    UPDATE "GameplayFeedConfig"
    SET
      "isActive" = FALSE,
      "lastErrorMsg" = 'Automatisch deaktiviert: Nitrado-Verbindung nicht aktiv/gebunden',
      "lastPolledAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "guildId" = NEW."guildId"
      AND "nitradoConnId" = NEW."id"
      AND "isActive" = TRUE;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "NitradoConnection_disable_gameplay_feeds_trg" ON "NitradoConnection";
CREATE TRIGGER "NitradoConnection_disable_gameplay_feeds_trg"
AFTER UPDATE OF "status"
ON "NitradoConnection"
FOR EACH ROW
EXECUTE FUNCTION "vbot_disable_gameplay_feeds_for_inactive_nitrado"();
