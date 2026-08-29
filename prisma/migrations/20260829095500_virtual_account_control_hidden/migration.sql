-- Control-surface tombstones for historical virtual system accounts.
-- Archived lottery pots must remain physically present because LotteryRound and
-- EconomyVirtualAccountEntry retain immutable audit/history references.

CREATE TABLE "EconomyVirtualAccountControlHidden" (
  "accountId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "nitradoConnId" TEXT NOT NULL,
  "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EconomyVirtualAccountControlHidden_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "EconomyVirtualAccountControlHidden_account_fkey"
    FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "EconomyVirtualAccountControlHidden_scope_idx"
  ON "EconomyVirtualAccountControlHidden"("guildId", "nitradoConnId");
