-- Nitrado-1X: durable encrypted identity for DB <-> Nitrado ban reconciliation.
-- The ban row remains the ownership/scope source of truth; deleting it cascades
-- the encrypted reconciliation secret automatically.
CREATE TABLE "ServerBanRemoteIdentity" (
    "banId" TEXT NOT NULL,
    "identifierEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerBanRemoteIdentity_pkey" PRIMARY KEY ("banId")
);

ALTER TABLE "ServerBanRemoteIdentity"
ADD CONSTRAINT "ServerBanRemoteIdentity_banId_fkey"
FOREIGN KEY ("banId") REFERENCES "ServerBanEntry"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Datenminimierung als DB-Invariante: Sobald weder lokaler Soll-Ban noch
-- bestaetigte Remote-Anwendung existieren, hat der entschluesselbare Repair-
-- Identifier keinen legitimen Zweck mehr. Bei Rebind bleibt active=true und das
-- Secret wird bewusst erhalten, damit der neue Service repariert werden kann.
CREATE OR REPLACE FUNCTION "cleanup_server_ban_remote_identity"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."active" = FALSE AND NEW."appliedRemotely" = FALSE THEN
        DELETE FROM "ServerBanRemoteIdentity" WHERE "banId" = NEW."id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServerBanEntry_cleanup_remote_identity"
AFTER UPDATE OF "active", "appliedRemotely" ON "ServerBanEntry"
FOR EACH ROW
WHEN (NEW."active" = FALSE AND NEW."appliedRemotely" = FALSE)
EXECUTE FUNCTION "cleanup_server_ban_remote_identity"();

-- Gegenlaeufige Race-Grenze: Ein spaeter/parallel eintreffendes Secret darf
-- einen bereits final inaktiven + remote entfernten Ban nicht wieder mit
-- entschluesselbarer Identitaet anreichern. RETURN NULL verwirft nur den Secret-
-- Write; der Ban-/Outbox-Workflow selbst bleibt davon unberuehrt.
CREATE OR REPLACE FUNCTION "guard_server_ban_remote_identity"()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "ServerBanEntry" b
        WHERE b."id" = NEW."banId"
          AND (b."active" = TRUE OR b."appliedRemotely" = TRUE)
    ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServerBanRemoteIdentity_guard_parent_state"
BEFORE INSERT OR UPDATE ON "ServerBanRemoteIdentity"
FOR EACH ROW
EXECUTE FUNCTION "guard_server_ban_remote_identity"();

-- Ein direkter Reconciler-Delete darf ein inzwischen durch Re-Ban wieder
-- benoetigtes Secret nicht entfernen. FK-Cascade vom Parent laeuft dagegen aus
-- einem RI-Trigger heraus (Trigger-Tiefe > 1) und muss immer durchgelassen werden.
CREATE OR REPLACE FUNCTION "guard_server_ban_remote_identity_delete"()
RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() = 1 AND EXISTS (
        SELECT 1
        FROM "ServerBanEntry" b
        WHERE b."id" = OLD."banId"
          AND (b."active" = TRUE OR b."appliedRemotely" = TRUE)
    ) THEN
        RETURN NULL;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServerBanRemoteIdentity_guard_delete"
BEFORE DELETE ON "ServerBanRemoteIdentity"
FOR EACH ROW
EXECUTE FUNCTION "guard_server_ban_remote_identity_delete"();
