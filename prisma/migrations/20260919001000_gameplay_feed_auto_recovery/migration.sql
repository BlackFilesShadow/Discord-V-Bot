-- Gameplay-Feed Self-Healing fuer temporaer ungueltige/entbundene Nitrado-Verbindungen.
--
-- Ziel:
-- 1) Systembedingte Pausen von manueller Deaktivierung unterscheiden.
-- 2) Bestehende, durch die alte Runtime-Hygiene automatisch deaktivierte Feeds
--    eindeutig als AUTO-PAUSED markieren.
-- 3) Auch einen temporaeren Service-Unbind/Rebind als systembedingte Pause
--    behandeln, ohne manuell deaktivierte Feeds anzufassen.
-- 4) Die eigentliche Reaktivierung erfolgt erst durch den ADM-Live-Sync, nachdem
--    Quelle und Chronologie wieder vollstaendig aufgeholt sind.

ALTER TABLE "GameplayFeedConfig"
  ADD COLUMN IF NOT EXISTS "autoPausedReason" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "autoPausedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "GameplayFeedConfig_autoPause_idx"
  ON "GameplayFeedConfig"("guildId", "nitradoConnId", "autoPausedReason");

-- Rueckwaertskompatibler Produktions-Backfill: Nur exakt die Zeilen markieren,
-- die die bisherige Datenbanklogik selbst deaktiviert hat. Manuell deaktivierte
-- Feeds bleiben ohne Marker und werden spaeter niemals automatisch reaktiviert.
UPDATE "GameplayFeedConfig"
SET
  "autoPausedReason" = 'NITRADO_INACTIVE',
  "autoPausedAt" = COALESCE("lastPolledAt", "updatedAt", CURRENT_TIMESTAMP)
WHERE "isActive" = FALSE
  AND "autoPausedReason" IS NULL
  AND "lastErrorMsg" = 'Automatisch deaktiviert: Nitrado-Verbindung nicht aktiv/gebunden';

CREATE OR REPLACE FUNCTION "vbot_disable_gameplay_feeds_for_inactive_nitrado"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Ein Feed wird nur dann automatisch pausiert, wenn die Verbindung fuer ADM
  -- effektiv unbrauchbar wird oder die gebundene Service-ID wechselt. Die
  -- UPDATEs greifen ausschliesslich auf aktuell aktive Feeds; manuell bereits
  -- deaktivierte Feeds erhalten daher bewusst keinen Auto-Pause-Marker.
  IF NEW."status" <> 'ACTIVE'
     OR NEW."nitradoServerId" IS NULL
     OR OLD."nitradoServerId" IS DISTINCT FROM NEW."nitradoServerId"
  THEN
    UPDATE "GameplayFeedDelivery"
    SET
      "status" = 'SKIPPED',
      "leaseUntil" = NULL,
      "lastError" = 'Skipped: linked Nitrado connection became unavailable',
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
      "autoPausedReason" = 'NITRADO_INACTIVE',
      "autoPausedAt" = CURRENT_TIMESTAMP,
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
AFTER UPDATE OF "status", "nitradoServerId"
ON "NitradoConnection"
FOR EACH ROW
EXECUTE FUNCTION "vbot_disable_gameplay_feeds_for_inactive_nitrado"();
