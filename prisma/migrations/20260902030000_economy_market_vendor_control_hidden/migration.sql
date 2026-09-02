-- Phase 3: sichere Haendler-Entfernung ohne historische Bestellungen/FKs zu zerstoeren.
-- Ein entfernter MARKET_VENDOR bleibt als archiviertes EconomyVirtualAccount bestehen;
-- dieser Marker blendet ihn dauerhaft aus den aktiven Schwarzmarkt-Control-Flaechen aus.

CREATE TABLE "EconomyMarketVendorControlHidden" (
  "vendorAccountId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyMarketVendorControlHidden_pkey" PRIMARY KEY ("vendorAccountId"),
  CONSTRAINT "EconomyMarketVendorControlHidden_vendor_scope_fkey"
    FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")
    REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EconomyMarketVendorControlHidden_scope_idx"
  ON "EconomyMarketVendorControlHidden"("guildId", "nitradoConnId");
