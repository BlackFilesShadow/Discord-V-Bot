-- NIT-008: FK NitradoJob/NitradoAdmCursor -> NitradoConnection (ON DELETE CASCADE).
-- Zuerst verwaiste Zeilen entfernen (referenzieren keine existierende
-- Connection mehr), sonst schlaegt das Anlegen des Constraints fehl.
DELETE FROM "NitradoJob"
WHERE "nitradoConnId" NOT IN (SELECT "id" FROM "NitradoConnection");

DELETE FROM "NitradoAdmCursor"
WHERE "nitradoConnId" NOT IN (SELECT "id" FROM "NitradoConnection");

CREATE INDEX IF NOT EXISTS "NitradoJob_nitradoConnId_idx" ON "NitradoJob"("nitradoConnId");
CREATE INDEX IF NOT EXISTS "NitradoAdmCursor_nitradoConnId_idx" ON "NitradoAdmCursor"("nitradoConnId");

ALTER TABLE "NitradoJob"
  ADD CONSTRAINT "NitradoJob_nitradoConnId_fkey"
  FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NitradoAdmCursor"
  ADD CONSTRAINT "NitradoAdmCursor_nitradoConnId_fkey"
  FOREIGN KEY ("nitradoConnId") REFERENCES "NitradoConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
