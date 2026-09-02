-- A user-visible deletion is terminal. Historical CUSTOM account rows may stay
-- physically present because immutable ledger/domain FKs use ON DELETE RESTRICT,
-- but they must never be restorable through the active control surface.
--
-- System accounts are domain-owned since the capability workspace and therefore
-- no longer belong in this generic deletion-marker table.

DELETE FROM "EconomyVirtualAccountControlHidden" marker
USING "EconomyVirtualAccount" account
WHERE marker."accountId" = account."id"
  AND account."kind" <> 'CUSTOM'::"EconomyVirtualAccountKind";

ALTER TABLE "EconomyVirtualAccountControlHidden"
  RENAME TO "EconomyVirtualAccountDeleted";

ALTER TABLE "EconomyVirtualAccountDeleted"
  RENAME COLUMN "hiddenAt" TO "deletedAt";

ALTER TABLE "EconomyVirtualAccountDeleted"
  RENAME CONSTRAINT "EconomyVirtualAccountControlHidden_pkey"
  TO "EconomyVirtualAccountDeleted_pkey";

ALTER TABLE "EconomyVirtualAccountDeleted"
  DROP CONSTRAINT "EconomyVirtualAccountControlHidden_account_fkey";

ALTER TABLE "EconomyVirtualAccountDeleted"
  ADD CONSTRAINT "EconomyVirtualAccountDeleted_account_scope_fkey"
  FOREIGN KEY ("accountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER INDEX "EconomyVirtualAccountControlHidden_scope_idx"
  RENAME TO "EconomyVirtualAccountDeleted_scope_idx";
