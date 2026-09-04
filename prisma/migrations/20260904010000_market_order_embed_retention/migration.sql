ALTER TABLE "EconomyMarketOrder"
  ADD COLUMN "orderMessageDeleteAt" TIMESTAMP(3),
  ADD COLUMN "orderMessageDeletedAt" TIMESTAMP(3);

CREATE INDEX "EconomyMarketOrder_closed_message_cleanup_idx"
  ON "EconomyMarketOrder" ("orderMessageDeletedAt", "orderMessageDeleteAt");