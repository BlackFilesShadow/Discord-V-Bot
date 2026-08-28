-- Economy completion 2026-08-28:
-- 1) Lotterie-Gewinn als Freitext mit getrenntem aktiven Wert und dauerhaftem Snapshot.
-- 2) Schwarzmarkt-Lieferpositionen sind Freitext statt DayZ-Classname.
-- 3) Bankzins bekommt feste Basispunkt-Praezision (100 bp = 1,00 %) ohne Float-Geldrechnung.

ALTER TABLE "LotteryRound"
  ADD COLUMN "activePrizeText" VARCHAR(256),
  ADD COLUMN "prizeSnapshot" VARCHAR(256);

ALTER TABLE "LotteryRound"
  ADD CONSTRAINT "LotteryRound_active_prize_text_check"
    CHECK ("activePrizeText" IS NULL OR char_length(trim("activePrizeText")) BETWEEN 1 AND 256),
  ADD CONSTRAINT "LotteryRound_prize_snapshot_check"
    CHECK ("prizeSnapshot" IS NULL OR char_length(trim("prizeSnapshot")) BETWEEN 1 AND 256);

-- Bestehende Schwarzmarkt-Daten bleiben 1:1 erhalten; nur die fachlich falsche
-- Classname-Bezeichnung wird auf den jetzt freien Itemtext umgestellt.
ALTER TABLE "EconomyMarketListingItem"
  DROP CONSTRAINT IF EXISTS "EconomyMarketListingItem_classname_check";
DROP INDEX IF EXISTS "EconomyMarketListingItem_listing_class_key";
ALTER TABLE "EconomyMarketListingItem"
  RENAME COLUMN "className" TO "itemText";
ALTER TABLE "EconomyMarketListingItem"
  ALTER COLUMN "itemText" TYPE VARCHAR(256),
  ADD CONSTRAINT "EconomyMarketListingItem_item_text_check"
    CHECK (char_length(trim("itemText")) BETWEEN 1 AND 256);
CREATE UNIQUE INDEX "EconomyMarketListingItem_listing_item_key"
  ON "EconomyMarketListingItem"("listingId", "itemText");

ALTER TABLE "EconomyConfig"
  ADD COLUMN "bankInterestBasisPoints" INTEGER;
UPDATE "EconomyConfig"
SET "bankInterestBasisPoints" = LEAST(GREATEST("bankInterestPercent", 0), 100) * 100
WHERE "bankInterestBasisPoints" IS NULL;
ALTER TABLE "EconomyConfig"
  ALTER COLUMN "bankInterestBasisPoints" SET DEFAULT 0,
  ALTER COLUMN "bankInterestBasisPoints" SET NOT NULL,
  ADD CONSTRAINT "EconomyConfig_bank_interest_basis_points_check"
    CHECK ("bankInterestBasisPoints" BETWEEN 0 AND 10000);

-- Historische Tageslaeufe behalten ihren alten Prozentwert und bekommen eine
-- exakte Basispunkt-Abbildung fuer neue Auswertungen.
ALTER TABLE "BankInterestRun"
  ADD COLUMN "interestBasisPoints" INTEGER;
UPDATE "BankInterestRun"
SET "interestBasisPoints" = LEAST(GREATEST("interestPercent", 0), 100) * 100
WHERE "interestBasisPoints" IS NULL;
ALTER TABLE "BankInterestRun"
  ALTER COLUMN "interestBasisPoints" SET DEFAULT 0,
  ALTER COLUMN "interestBasisPoints" SET NOT NULL,
  ADD CONSTRAINT "BankInterestRun_interest_basis_points_check"
    CHECK ("interestBasisPoints" BETWEEN 0 AND 10000);
