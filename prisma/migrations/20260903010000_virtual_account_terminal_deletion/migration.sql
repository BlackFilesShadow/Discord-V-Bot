-- Terminal CUSTOM-account deletion with a dedicated historical identity.
-- Live EconomyVirtualAccount rows may now be physically removed while immutable
-- ledger/lottery/market/order rows retain a scoped FK target outside live storage.
-- No balances or domain history are rewritten or cascaded away.

CREATE TABLE "EconomyVirtualAccountHistoryIdentity" (
  "accountId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "kind" "EconomyVirtualAccountKind" NOT NULL,
  "nameSnapshot" VARCHAR(80) NOT NULL,
  "createdByDiscordId" TEXT NOT NULL,
  "accountCreatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "deletedByDiscordId" TEXT,
  CONSTRAINT "EconomyVirtualAccountHistoryIdentity_pkey" PRIMARY KEY ("accountId")
);

CREATE UNIQUE INDEX "EconomyVirtualAccountHistoryIdentity_scope_key"
  ON "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId");
CREATE INDEX "EconomyVirtualAccountHistoryIdentity_deleted_scope_idx"
  ON "EconomyVirtualAccountHistoryIdentity"("guildId", "nitradoConnId", "deletedAt");

INSERT INTO "EconomyVirtualAccountHistoryIdentity" (
  "accountId", "guildId", "nitradoConnId", "kind", "nameSnapshot",
  "createdByDiscordId", "accountCreatedAt", "deletedAt", "deletedByDiscordId"
)
SELECT
  "id", "guildId", "nitradoConnId", "kind", "name",
  "createdByDiscordId", "createdAt", NULL, NULL
FROM "EconomyVirtualAccount";

-- Keep a scoped identity for every future live account without touching any money
-- or domain behavior. A terminally deleted identity cannot be reused as a live ID.
CREATE FUNCTION "economy_virtual_account_history_identity_sync"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "EconomyVirtualAccountHistoryIdentity" (
    "accountId", "guildId", "nitradoConnId", "kind", "nameSnapshot",
    "createdByDiscordId", "accountCreatedAt", "deletedAt", "deletedByDiscordId"
  ) VALUES (
    NEW."id", NEW."guildId", NEW."nitradoConnId", NEW."kind", NEW."name",
    NEW."createdByDiscordId", NEW."createdAt", NULL, NULL
  )
  ON CONFLICT ("accountId") DO UPDATE SET
    "guildId" = EXCLUDED."guildId",
    "nitradoConnId" = EXCLUDED."nitradoConnId",
    "kind" = EXCLUDED."kind",
    "nameSnapshot" = EXCLUDED."nameSnapshot",
    "createdByDiscordId" = EXCLUDED."createdByDiscordId",
    "accountCreatedAt" = EXCLUDED."accountCreatedAt"
  WHERE "EconomyVirtualAccountHistoryIdentity"."deletedAt" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'terminal virtual-account identity cannot be reused: %', NEW."id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "EconomyVirtualAccount_history_identity_sync"
AFTER INSERT OR UPDATE OF "guildId", "nitradoConnId", "kind", "name", "createdByDiscordId"
ON "EconomyVirtualAccount"
FOR EACH ROW EXECUTE FUNCTION "economy_virtual_account_history_identity_sync"();

-- Repoint only history/domain reference FKs. The scalar account IDs remain
-- unchanged, so immutable rows are not copied, rewritten or deleted.
ALTER TABLE "EconomyVirtualAccountEntry"
  DROP CONSTRAINT IF EXISTS "EconomyVirtualAccountEntry_account_scope_fkey";
ALTER TABLE "EconomyVirtualAccountEntry"
  ADD CONSTRAINT "EconomyVirtualAccountEntry_history_identity_fkey"
  FOREIGN KEY ("virtualAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryRound"
  DROP CONSTRAINT IF EXISTS "LotteryRound_pot_scope_fkey";
ALTER TABLE "LotteryRound"
  ADD CONSTRAINT "LotteryRound_pot_history_identity_fkey"
  FOREIGN KEY ("potAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EconomyMarketListing"
  DROP CONSTRAINT IF EXISTS "EconomyMarketListing_vendor_scope_fkey";
ALTER TABLE "EconomyMarketListing"
  ADD CONSTRAINT "EconomyMarketListing_vendor_history_identity_fkey"
  FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EconomyMarketPurchase"
  DROP CONSTRAINT IF EXISTS "EconomyMarketPurchase_vendor_scope_fkey";
ALTER TABLE "EconomyMarketPurchase"
  ADD CONSTRAINT "EconomyMarketPurchase_vendor_history_identity_fkey"
  FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EconomyMarketOrder"
  DROP CONSTRAINT IF EXISTS "EconomyMarketOrder_vendor_scope_fkey";
ALTER TABLE "EconomyMarketOrder"
  ADD CONSTRAINT "EconomyMarketOrder_vendor_history_identity_fkey"
  FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Upgrade fail-closed: old generic hidden CUSTOM rows may only become terminal
-- deletes when they are empty and no domain operation is still active.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "EconomyVirtualAccountControlHidden" marker
    JOIN "EconomyVirtualAccount" account ON account."id" = marker."accountId"
    LEFT JOIN "EconomyVirtualAccountFinance" finance
      ON finance."accountId" = account."id"
     AND finance."guildId" = account."guildId"
     AND finance."nitradoConnId" = account."nitradoConnId"
    WHERE account."kind" = 'CUSTOM'::"EconomyVirtualAccountKind"
      AND (finance."accountId" IS NULL OR account."balance" <> 0 OR finance."bankBalance" <> 0)
  ) THEN
    RAISE EXCEPTION 'terminal deletion migration blocked: hidden CUSTOM account has funds or missing finance';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "EconomyVirtualAccountControlHidden" marker
    JOIN "EconomyVirtualAccount" account ON account."id" = marker."accountId"
    WHERE account."kind" = 'CUSTOM'::"EconomyVirtualAccountKind"
      AND (
        EXISTS (SELECT 1 FROM "LotteryRound" r WHERE r."potAccountId"=account."id" AND r."status" IN ('ACTIVE','DRAWING','REFUNDING'))
        OR EXISTS (SELECT 1 FROM "EconomyMarketListing" l WHERE l."vendorAccountId"=account."id" AND l."active"=TRUE)
        OR EXISTS (SELECT 1 FROM "EconomyMarketOrder" o WHERE o."vendorAccountId"=account."id" AND o."status"='OPEN'::"EconomyMarketOrderStatus")
      )
  ) THEN
    RAISE EXCEPTION 'terminal deletion migration blocked: hidden CUSTOM account still owns active domain work';
  END IF;
END $$;

UPDATE "EconomyVirtualAccountHistoryIdentity" history
SET "deletedAt" = marker."hiddenAt",
    "deletedByDiscordId" = account."archivedByDiscordId",
    "nameSnapshot" = account."name",
    "kind" = account."kind"
FROM "EconomyVirtualAccountControlHidden" marker
JOIN "EconomyVirtualAccount" account ON account."id" = marker."accountId"
WHERE history."accountId" = account."id"
  AND account."kind" = 'CUSTOM'::"EconomyVirtualAccountKind";

DELETE FROM "EconomyVirtualAccount" account
USING "EconomyVirtualAccountControlHidden" marker
WHERE account."id" = marker."accountId"
  AND account."kind" = 'CUSTOM'::"EconomyVirtualAccountKind"
  AND account."balance" = 0;

-- Old control-hidden semantics are gone. System-account markers are discarded;
-- their live rows remain domain-owned and are not generically deleted.
DROP TABLE "EconomyVirtualAccountControlHidden";
