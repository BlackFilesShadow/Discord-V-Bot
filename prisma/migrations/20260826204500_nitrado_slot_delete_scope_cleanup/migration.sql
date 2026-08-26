-- Prevent delete/recreate of a Nitrado slot from leaving stale gameserver-scoped rows.
--
-- The cleanup is intentionally database-enforced. Runtime code can evolve and new
-- scoped tables can be added without silently creating a new orphan class.
-- Every public base table carrying nitradoConnId is discovered dynamically.
-- Tables carrying guildId are deleted with the full tenant+gameserver scope;
-- tables without guildId use the globally unique connection id.

-- The economy migration marker must never stay RESOLVED against a deleted
-- connection. Existing dirty rows are rejected fail-closed before the FK is added.
DO $$
DECLARE
  broken bigint;
BEGIN
  SELECT COUNT(*)
  INTO broken
  FROM "EconomyScopeMigration" m
  LEFT JOIN "NitradoConnection" n
    ON n."id" = m."primaryNitradoConnId"
   AND n."guildId" = m."guildId"
  WHERE m."primaryNitradoConnId" IS NOT NULL
    AND n."id" IS NULL;

  IF broken > 0 THEN
    RAISE EXCEPTION 'NITRADO_DELETE_PRECHECK: % stale EconomyScopeMigration rows must be repaired before migration', broken;
  END IF;
END $$;

ALTER TABLE "EconomyScopeMigration"
  DROP CONSTRAINT IF EXISTS "EconomyScopeMigration_primary_nitrado_scope_fkey";
ALTER TABLE "EconomyScopeMigration"
  ADD CONSTRAINT "EconomyScopeMigration_primary_nitrado_scope_fkey"
  FOREIGN KEY ("primaryNitradoConnId", "guildId")
  REFERENCES "NitradoConnection"("id", "guildId")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "vbot_cleanup_nitrado_connection_scope_before_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scoped record;
  affected bigint;
  remaining bigint;
  progress bigint;
  pass_no integer := 0;
  max_passes integer := 1;
BEGIN
  -- Serialise writes into every table that can carry a Nitrado connection id.
  -- SHARE ROW EXCLUSIVE blocks concurrent INSERT/UPDATE/DELETE while this rare
  -- owner-only destructive operation completes, preventing a post-cleanup race.
  FOR scoped IN
    SELECT
      c.table_schema,
      c.table_name,
      bool_or(c.column_name = 'guildId') AS has_guild_id
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('nitradoConnId', 'guildId')
      AND c.table_name <> 'NitradoConnection'
    GROUP BY c.table_schema, c.table_name
    HAVING bool_or(c.column_name = 'nitradoConnId')
    ORDER BY c.table_schema, c.table_name
  LOOP
    EXECUTE format(
      'LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',
      scoped.table_schema,
      scoped.table_name
    );
    max_passes := max_passes + 1;
  END LOOP;

  LOCK TABLE "EconomyScopeMigration" IN SHARE ROW EXCLUSIVE MODE;

  -- A RESOLVED legacy economy belongs to this server. Deleting the server and
  -- all of its scoped economy rows also removes that binding atomically.
  DELETE FROM "EconomyScopeMigration"
  WHERE "guildId" = OLD."guildId"
    AND "primaryNitradoConnId" = OLD."id";

  -- Child-first without a hard-coded table list. A parent delete blocked by a
  -- RESTRICT FK is retried after dependent scoped rows were removed later in
  -- the pass. If nothing can make progress, abort the parent delete instead of
  -- leaving an ambiguous half-cleaned production truth.
  LOOP
    pass_no := pass_no + 1;
    progress := 0;

    FOR scoped IN
      SELECT
        c.table_schema,
        c.table_name,
        bool_or(c.column_name = 'guildId') AS has_guild_id
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name IN ('nitradoConnId', 'guildId')
        AND c.table_name <> 'NitradoConnection'
      GROUP BY c.table_schema, c.table_name
      HAVING bool_or(c.column_name = 'nitradoConnId')
      ORDER BY c.table_schema, c.table_name
    LOOP
      BEGIN
        IF scoped.has_guild_id THEN
          EXECUTE format(
            'DELETE FROM %I.%I WHERE "nitradoConnId" = $1 AND "guildId" = $2',
            scoped.table_schema,
            scoped.table_name
          ) USING OLD."id", OLD."guildId";
        ELSE
          EXECUTE format(
            'DELETE FROM %I.%I WHERE "nitradoConnId" = $1',
            scoped.table_schema,
            scoped.table_name
          ) USING OLD."id";
        END IF;

        GET DIAGNOSTICS affected = ROW_COUNT;
        progress := progress + affected;
      EXCEPTION
        WHEN foreign_key_violation THEN
          -- A scoped child still exists; retry this parent next pass.
          NULL;
      END;
    END LOOP;

    remaining := 0;
    FOR scoped IN
      SELECT
        c.table_schema,
        c.table_name,
        bool_or(c.column_name = 'guildId') AS has_guild_id
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name IN ('nitradoConnId', 'guildId')
        AND c.table_name <> 'NitradoConnection'
      GROUP BY c.table_schema, c.table_name
      HAVING bool_or(c.column_name = 'nitradoConnId')
      ORDER BY c.table_schema, c.table_name
    LOOP
      IF scoped.has_guild_id THEN
        EXECUTE format(
          'SELECT COUNT(*) FROM %I.%I WHERE "nitradoConnId" = $1 AND "guildId" = $2',
          scoped.table_schema,
          scoped.table_name
        ) INTO affected USING OLD."id", OLD."guildId";
      ELSE
        EXECUTE format(
          'SELECT COUNT(*) FROM %I.%I WHERE "nitradoConnId" = $1',
          scoped.table_schema,
          scoped.table_name
        ) INTO affected USING OLD."id";
      END IF;
      remaining := remaining + affected;
    END LOOP;

    EXIT WHEN remaining = 0;

    IF progress = 0 OR pass_no >= max_passes THEN
      RAISE EXCEPTION
        'NITRADO_SLOT_DELETE_SCOPE_BLOCKED: % scoped rows for connection % could not be deleted safely',
        remaining,
        OLD."id";
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "trg_nitrado_connection_scope_cleanup" ON "NitradoConnection";
CREATE TRIGGER "trg_nitrado_connection_scope_cleanup"
BEFORE DELETE ON "NitradoConnection"
FOR EACH ROW
EXECUTE FUNCTION "vbot_cleanup_nitrado_connection_scope_before_delete"();
