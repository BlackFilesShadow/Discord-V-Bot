-- Schwarzmarkt-Fulfillment: exakte DayZ-Bundles pro Listing und unveraenderliche
-- Liefer-Snapshots pro Kauf. Bestehende Kaeufe werden bewusst als LEGACY
-- markiert, damit sie nach dem Rollout nicht versehentlich erneut geliefert
-- oder refundiert werden.

-- Scoped Child-FKs duerfen nicht nur auf die globale Purchase-ID vertrauen.
-- Die bestehende Tabelle hatte zwar eine globale PK auf id, aber noch keinen
-- expliziten Scope-Key fuer (id, guildId, nitradoConnId).
ALTER TABLE "EconomyMarketPurchase"
  ADD CONSTRAINT "EconomyMarketPurchase_id_scope_key"
  UNIQUE ("id", "guildId", "nitradoConnId");

CREATE TABLE "EconomyMarketListingItem" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "className" VARCHAR(128) NOT NULL,
  "quantity" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyMarketListingItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketListingItem_quantity_check" CHECK ("quantity" >= 1 AND "quantity" <= 1000),
  CONSTRAINT "EconomyMarketListingItem_classname_check" CHECK (length("className") BETWEEN 1 AND 128),
  CONSTRAINT "EconomyMarketListingItem_listing_scope_fkey"
    FOREIGN KEY ("listingId", "guildId", "nitradoConnId")
    REFERENCES "EconomyMarketListing"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EconomyMarketListingItem_listing_class_key"
  ON "EconomyMarketListingItem"("listingId", "className");
CREATE INDEX "EconomyMarketListingItem_scope_idx"
  ON "EconomyMarketListingItem"("guildId", "nitradoConnId", "listingId");

CREATE TABLE "EconomyMarketPurchaseFulfillment" (
  "purchaseId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "deliveryItems" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "fulfilledAt" TIMESTAMP(3),
  "fulfilledByDiscordId" TEXT,
  "fulfillmentNote" VARCHAR(500),
  "refundedAt" TIMESTAMP(3),
  "refundedByDiscordId" TEXT,
  "refundReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyMarketPurchaseFulfillment_pkey" PRIMARY KEY ("purchaseId"),
  CONSTRAINT "EconomyMarketPurchaseFulfillment_status_check"
    CHECK ("status" IN ('PENDING','DELIVERED','REFUNDED','LEGACY')),
  CONSTRAINT "EconomyMarketPurchaseFulfillment_items_array_check"
    CHECK (jsonb_typeof("deliveryItems") = 'array'),
  CONSTRAINT "EconomyMarketPurchaseFulfillment_terminal_shape_check" CHECK (
    ("status" = 'PENDING' AND "fulfilledAt" IS NULL AND "refundedAt" IS NULL)
    OR ("status" = 'DELIVERED' AND "fulfilledAt" IS NOT NULL AND "refundedAt" IS NULL)
    OR ("status" = 'REFUNDED' AND "refundedAt" IS NOT NULL AND "fulfilledAt" IS NULL)
    OR ("status" = 'LEGACY' AND "fulfilledAt" IS NULL AND "refundedAt" IS NULL)
  ),
  CONSTRAINT "EconomyMarketPurchaseFulfillment_purchase_scope_fkey"
    FOREIGN KEY ("purchaseId", "guildId", "nitradoConnId")
    REFERENCES "EconomyMarketPurchase"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EconomyMarketPurchaseFulfillment_scope_status_idx"
  ON "EconomyMarketPurchaseFulfillment"("guildId", "nitradoConnId", "status");

INSERT INTO "EconomyMarketPurchaseFulfillment" (
  "purchaseId", "guildId", "nitradoConnId", "status", "deliveryItems", "createdAt", "updatedAt"
)
SELECT
  p."id", p."guildId", p."nitradoConnId", 'LEGACY', '[]'::jsonb, p."createdAt", CURRENT_TIMESTAMP
FROM "EconomyMarketPurchase" p
ON CONFLICT ("purchaseId") DO NOTHING;
