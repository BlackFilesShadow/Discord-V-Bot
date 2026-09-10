-- Follow-up auf die Produktionspruefung nach PR #399.
--
-- 1) Weitere bekannte DayZ-Statuszeilen werden als bewusst ignorierte ADM-
--    Noise klassifiziert, ohne Rohdaten oder Eventtyp zu verlieren.
-- 2) RESTART_IF_DOWN Jobs, die ausschliesslich wegen eines offenen Nitrado-
--    Circuit-Breakers DEAD wurden, werden auf aktiven Keep-Online-Verbindungen
--    einmalig sicher requeued und auf die neue Retry-Grenze angehoben.

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
       OR NEW."rawLine" LIKE '%) is unconscious'
       OR NEW."rawLine" LIKE '%) regained consciousness'
     )
  THEN
    NEW."parseStatus" := 'IGNORED';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE "AdmEvent"
SET "parseStatus" = 'IGNORED'
WHERE "eventType" = 'UNKNOWN'
  AND "rawLine" LIKE 'Player "%'
  AND (
    "rawLine" LIKE '%) is connecting'
    OR "rawLine" LIKE '%) performed Emote%'
    OR "rawLine" LIKE '%) is unconscious'
    OR "rawLine" LIKE '%) regained consciousness'
  )
  AND "parseStatus" IS DISTINCT FROM 'IGNORED';

UPDATE "NitradoJob" AS j
SET
  "status" = 'PENDING',
  "attempts" = 0,
  "maxAttempts" = GREATEST(j."maxAttempts", 8),
  "nextRunAt" = CURRENT_TIMESTAMP,
  "lastError" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE j."operation" = 'RESTART_IF_DOWN'
  AND j."status" = 'DEAD'
  AND j."lastError" LIKE 'Nitrado circuit breaker is OPEN%'
  AND EXISTS (
    SELECT 1
    FROM "NitradoConnection" AS n
    WHERE n."id" = j."nitradoConnId"
      AND n."guildId" = j."guildId"
      AND n."status" = 'ACTIVE'
      AND n."keepOnlineEnabled" = TRUE
      AND n."nitradoServerId" IS NOT NULL
  );
