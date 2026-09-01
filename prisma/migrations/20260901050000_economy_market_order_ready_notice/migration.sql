-- Mehrfach-Item-Bestellung fuer den Schwarzmarkt-Katalog: buendelt mehrere
-- EconomyMarketPurchase-Zeilen zu einer Bestellung mit Kanal-Embed. Bestehende
-- Einzelkauf-Zeilen bleiben unveraendert (orderId bleibt NULL).
-- Dokumentiert zusaetzlich den bereits real existierenden, aber im Schema
-- bislang nicht deklarierten Unique-Constraint auf EconomyMarketPurchase, den
-- EconomyMarketPurchaseFulfillment referenziert (kein DB-Effekt, IF NOT EXISTS).
DO $$ BEGIN
  ALTER TABLE "EconomyMarketPurchase"
    ADD CONSTRAINT "EconomyMarketPurchase_id_scope_key" UNIQUE ("id", "guildId", "nitradoConnId");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE TYPE "EconomyMarketOrderStatus" AS ENUM ('OPEN', 'CLOSED');

ALTER TABLE "EconomyMarketDiscordProjection"
  ADD COLUMN "orderChannelId" TEXT,
  ADD COLUMN "orderReadyChannelId" TEXT;

CREATE TABLE "EconomyMarketOrder" (
  "id" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "vendorAccountId" TEXT NOT NULL,
  "userDiscordId" TEXT NOT NULL,
  "totalAmount" BIGINT NOT NULL,
  "status" "EconomyMarketOrderStatus" NOT NULL DEFAULT 'OPEN',
  "orderChannelId" TEXT,
  "orderMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closedByDiscordId" TEXT,
  CONSTRAINT "EconomyMarketOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketOrder_total_amount_positive_check" CHECK ("totalAmount" > 0),
  CONSTRAINT "EconomyMarketOrder_vendor_scope_fkey" FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId") REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "EconomyMarketOrder_scope_status_idx" ON "EconomyMarketOrder"("guildId", "nitradoConnId", "vendorAccountId", "status");
CREATE INDEX "EconomyMarketOrder_scope_user_created_idx" ON "EconomyMarketOrder"("guildId", "nitradoConnId", "userDiscordId", "createdAt");

ALTER TABLE "EconomyMarketPurchase" ADD COLUMN "orderId" TEXT;
ALTER TABLE "EconomyMarketPurchase"
  ADD CONSTRAINT "EconomyMarketPurchase_order_fkey" FOREIGN KEY ("orderId") REFERENCES "EconomyMarketOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EconomyMarketPurchase_order_idx" ON "EconomyMarketPurchase"("orderId");

-- Persistenter Zustellungs-/Loesch-Datensatz fuer die "Bestellung bereit"-
-- Mention (Muster: ServerBanExpiryNotice) - garantiert die 1-Minuten-Loeschung
-- auch ueber einen Bot-Neustart hinweg statt eines verlierbaren setTimeout.
CREATE TABLE "EconomyMarketOrderReadyNotice" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "userDiscordId" TEXT NOT NULL,
  "messageId" TEXT,
  "deleteAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomyMarketOrderReadyNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EconomyMarketOrderReadyNotice_order_key" UNIQUE ("orderId"),
  CONSTRAINT "EconomyMarketOrderReadyNotice_order_fkey" FOREIGN KEY ("orderId") REFERENCES "EconomyMarketOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EconomyMarketOrderReadyNotice_pending_idx" ON "EconomyMarketOrderReadyNotice"("deletedAt", "deleteAt");
CREATE INDEX "EconomyMarketOrderReadyNotice_scope_idx" ON "EconomyMarketOrderReadyNotice"("guildId", "nitradoConnId");
