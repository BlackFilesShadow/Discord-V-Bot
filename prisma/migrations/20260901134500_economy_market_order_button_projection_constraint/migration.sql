-- Der Schwarzmarkt-Sync persistiert neben CATALOG und DIRECT_BUY auch genau
-- einen katalogweiten ORDER_BUTTON. Die Runtime wurde bereits mit
-- ORDER_BUTTON ausgeliefert, waehrend die urspruengliche DB-Constraint nur die
-- beiden alten Kinds erlaubte. Das fuehrt beim Sync zu
-- EconomyMarketDiscordMessage_kind_check und verhindert den Bestellbutton.
--
-- Diese Migration bringt die Persistenz-Constraints auf den tatsaechlichen
-- Runtime-Vertrag. Bestehende CATALOG/DIRECT_BUY-Zeilen bleiben unveraendert.

ALTER TABLE "EconomyMarketDiscordMessage"
  DROP CONSTRAINT IF EXISTS "EconomyMarketDiscordMessage_kind_check";

ALTER TABLE "EconomyMarketDiscordMessage"
  ADD CONSTRAINT "EconomyMarketDiscordMessage_kind_check"
  CHECK ("kind" IN ('CATALOG', 'DIRECT_BUY', 'ORDER_BUTTON'));

ALTER TABLE "EconomyMarketDiscordMessage"
  DROP CONSTRAINT IF EXISTS "EconomyMarketDiscordMessage_shape_check";

ALTER TABLE "EconomyMarketDiscordMessage"
  ADD CONSTRAINT "EconomyMarketDiscordMessage_shape_check"
  CHECK (
    ("kind" = 'CATALOG' AND "pageIndex" IS NOT NULL AND "listingId" IS NULL)
    OR ("kind" = 'DIRECT_BUY' AND "pageIndex" IS NULL AND "listingId" IS NOT NULL)
    OR ("kind" = 'ORDER_BUTTON' AND "pageIndex" = 0 AND "listingId" IS NULL)
  );
