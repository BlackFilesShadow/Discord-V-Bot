ALTER TABLE "FlagActivityEvent"
  ADD COLUMN IF NOT EXISTS "totemType" TEXT;

-- Existing canonical flag rows were created from the strict vanilla shape
-- `... has raised/lowered <flag> on <TotemClass> at <x,y,z>`. Preserve that
-- exact source classname instead of inventing TerritoryFlag for historical
-- rows. Rows that do not match the canonical shape remain NULL/fail-closed.
UPDATE "FlagActivityEvent"
   SET "totemType" = substring(
     "rawLine"
     FROM '[[:space:]]on[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+at[[:space:]]+<'
   )
 WHERE "totemType" IS NULL;
