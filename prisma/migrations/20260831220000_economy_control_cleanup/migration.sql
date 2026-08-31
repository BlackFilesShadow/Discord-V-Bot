-- Economy control cleanup:
-- - Schwarzmarkt-Angebote koennen aus der Bedienoberflaeche entfernt werden,
--   ohne historische Bestellungen oder deren Foreign Keys zu zerstoeren.
-- - Der fruehere fachliche Max-pro-Kauf-Deckel wird entfernt. Die Spalte
--   maxPerPurchase bleibt nur als Legacy-Kompatibilitaetsfeld bestehen und wird
--   von neuen Kaufpfaden nicht mehr ausgewertet.
-- - EconomyMarketPurchase.quantity wird nur noch auf > 0 begrenzt; die
--   physische INTEGER-Grenze von PostgreSQL bleibt die technische Obergrenze.

CREATE TABLE "EconomyMarketListingControlHidden" (
  "listingId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyMarketListingControlHidden_pkey" PRIMARY KEY ("listingId"),
  CONSTRAINT "EconomyMarketListingControlHidden_listing_fkey"
    FOREIGN KEY ("listingId", "guildId", "nitradoConnId")
    REFERENCES "EconomyMarketListing"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EconomyMarketListingControlHidden_scope_idx"
  ON "EconomyMarketListingControlHidden"("guildId", "nitradoConnId");

ALTER TABLE "EconomyMarketPurchase"
  DROP CONSTRAINT IF EXISTS "EconomyMarketPurchase_quantity_positive_check";
ALTER TABLE "EconomyMarketPurchase"
  ADD CONSTRAINT "EconomyMarketPurchase_quantity_positive_check"
  CHECK ("quantity" >= 1);

ALTER TABLE "EconomyMarketListing"
  DROP CONSTRAINT IF EXISTS "EconomyMarketListing_max_purchase_check";
ALTER TABLE "EconomyMarketListing"
  ADD CONSTRAINT "EconomyMarketListing_max_purchase_legacy_check"
  CHECK ("maxPerPurchase" >= 1);

ALTER TABLE "EconomyMarketListing"
  ALTER COLUMN "maxPerPurchase" SET DEFAULT 1;
