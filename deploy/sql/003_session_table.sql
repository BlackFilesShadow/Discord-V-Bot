-- Session-Tabelle fuer connect-pg-simple (Express-Session-Store).
-- Wird normalerweise via createTableIfMissing:true automatisch angelegt,
-- aber: bei concurrent first-requests gibt's eine Race-Condition wodurch
-- der erste Request fehlschlaegt mit "relation \"session\" does not exist".
-- Idempotente Anlage hier loest das deterministisch.
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session"
      ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
