-- NIT-012: serviceId (Mirror-Feld) aus dem kanonischen nitradoServerId
-- backfuellen, wo es fehlt. Nur NULLs werden gefuellt -> kein Ueberschreiben
-- abweichender Werte (Konflikte bleiben unangetastet).
UPDATE "NitradoConnection"
SET "serviceId" = "nitradoServerId"
WHERE "serviceId" IS NULL
  AND "nitradoServerId" IS NOT NULL;
