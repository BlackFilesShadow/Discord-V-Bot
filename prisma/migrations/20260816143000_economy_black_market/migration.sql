ALTER TYPE "EconomyTxType" ADD VALUE IF NOT EXISTS 'MARKET_PURCHASE';

CREATE TABLE "EconomyMarketListing" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "vendorAccountId" TEXT NOT NULL,
  "sku" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "price" BIGINT NOT NULL,
  "stock" INTEGER NOT NULL,
  "maxPerPurchase" INTEGER NOT NULL DEFAULT 10,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "archivedAt" TIMESTAMP(3),
  "archivedByDiscordId" TEXT,
  "createdByDiscordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyMarketListing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketListing_price_positive_check" CHECK ("price" > 0),
  CONSTRAINT "EconomyMarketListing_stock_nonnegative_check" CHECK ("stock" >= 0),
  CONSTRAINT "EconomyMarketListing_max_purchase_check" CHECK ("maxPerPurchase" >= 1 AND "maxPerPurchase" <= 1000),
  CONSTRAINT "EconomyMarketListing_vendor_fkey" FOREIGN KEY ("vendorAccountId") REFERENCES "EconomyVirtualAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EconomyMarketListing_scope_sku_key" ON "EconomyMarketListing"("guildId", "nitradoConnId", "sku");
CREATE INDEX "EconomyMarketListing_scope_active_idx" ON "EconomyMarketListing"("guildId", "nitradoConnId", "active");
CREATE INDEX "EconomyMarketListing_vendor_idx" ON "EconomyMarketListing"("vendorAccountId");

CREATE TABLE "EconomyMarketPurchase" (
  "id" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "listingId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "vendorAccountId" TEXT NOT NULL,
  "userDiscordId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPrice" BIGINT NOT NULL,
  "amount" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyMarketPurchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketPurchase_quantity_positive_check" CHECK ("quantity" >= 1 AND "quantity" <= 1000),
  CONSTRAINT "EconomyMarketPurchase_unit_price_positive_check" CHECK ("unitPrice" > 0),
  CONSTRAINT "EconomyMarketPurchase_amount_positive_check" CHECK ("amount" > 0),
  CONSTRAINT "EconomyMarketPurchase_amount_consistency_check" CHECK ("amount" = "unitPrice" * "quantity"),
  CONSTRAINT "EconomyMarketPurchase_listing_fkey" FOREIGN KEY ("listingId") REFERENCES "EconomyMarketListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EconomyMarketPurchase_vendor_fkey" FOREIGN KEY ("vendorAccountId") REFERENCES "EconomyVirtualAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EconomyMarketPurchase_idempotency_key" ON "EconomyMarketPurchase"("idempotencyKey");
CREATE INDEX "EconomyMarketPurchase_scope_user_created_idx" ON "EconomyMarketPurchase"("guildId", "nitradoConnId", "userDiscordId", "createdAt");
CREATE INDEX "EconomyMarketPurchase_listing_created_idx" ON "EconomyMarketPurchase"("listingId", "createdAt");
