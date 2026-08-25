-- Production batch 2026-08-26: erweitert bestehende EconomyVirtualAccount-Konten
-- additiv. Das bestehende `balance` bleibt absichtlich das kanonische virtuelle
-- WALLET, damit Lotterie/Schwarzmarkt und bestehende Ledger-Pfade ohne
-- Datenmigration funktionsfaehig bleiben. `bankBalance` ist der neue zweite
-- Pocket. Discord-Projektion/Manager sind strikt Guild+Gameserver-gescoppt.

CREATE TABLE "EconomyVirtualAccountFinance" (
    "accountId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "bankBalance" BIGINT NOT NULL DEFAULT 0,
    "currencyName" VARCHAR(40) NOT NULL DEFAULT 'Coins',
    "currencyEmoji" VARCHAR(100) NOT NULL DEFAULT '💰',
    "accountEmoji" VARCHAR(100) NOT NULL DEFAULT '🏦',
    "bannerUrl" VARCHAR(512),
    "textStyle" VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    "exchangePlayerUnits" BIGINT,
    "exchangeAccountUnits" BIGINT,
    "accountPurpose" VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualAccountFinance_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "EconomyVirtualAccountFinance_bank_nonnegative" CHECK ("bankBalance" >= 0),
    CONSTRAINT "EconomyVirtualAccountFinance_currency_name_nonempty" CHECK (char_length(trim("currencyName")) BETWEEN 1 AND 40),
    CONSTRAINT "EconomyVirtualAccountFinance_currency_emoji_nonempty" CHECK (char_length(trim("currencyEmoji")) BETWEEN 1 AND 100),
    CONSTRAINT "EconomyVirtualAccountFinance_text_style_check" CHECK ("textStyle" IN ('NORMAL','BOLD','ITALIC','BOLD_ITALIC')),
    CONSTRAINT "EconomyVirtualAccountFinance_purpose_check" CHECK ("accountPurpose" IN ('GENERAL','BANK_TREASURY')),
    CONSTRAINT "EconomyVirtualAccountFinance_exchange_pair_check" CHECK (
      ("exchangePlayerUnits" IS NULL AND "exchangeAccountUnits" IS NULL)
      OR ("exchangePlayerUnits" > 0 AND "exchangeAccountUnits" > 0)
    )
);

ALTER TABLE "EconomyVirtualAccountFinance"
    ADD CONSTRAINT "EconomyVirtualAccountFinance_account_fkey"
    FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "EconomyVirtualAccountFinance_scope_idx"
    ON "EconomyVirtualAccountFinance"("guildId", "nitradoConnId");
CREATE INDEX "EconomyVirtualAccountFinance_purpose_idx"
    ON "EconomyVirtualAccountFinance"("guildId", "nitradoConnId", "accountPurpose");
CREATE UNIQUE INDEX "EconomyVirtualAccountFinance_one_bank_treasury_per_scope"
    ON "EconomyVirtualAccountFinance"("guildId", "nitradoConnId", "accountPurpose")
    WHERE "accountPurpose"='BANK_TREASURY';

CREATE TABLE "EconomyVirtualAccountProjection" (
    "accountId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT,
    "archiveThreadId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualAccountProjection_pkey" PRIMARY KEY ("accountId")
);

ALTER TABLE "EconomyVirtualAccountProjection"
    ADD CONSTRAINT "EconomyVirtualAccountProjection_account_fkey"
    FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "EconomyVirtualAccountProjection_scope_idx"
    ON "EconomyVirtualAccountProjection"("guildId", "nitradoConnId");
CREATE UNIQUE INDEX "EconomyVirtualAccountProjection_message_key"
    ON "EconomyVirtualAccountProjection"("messageId") WHERE "messageId" IS NOT NULL;
CREATE UNIQUE INDEX "EconomyVirtualAccountProjection_archive_thread_key"
    ON "EconomyVirtualAccountProjection"("archiveThreadId") WHERE "archiveThreadId" IS NOT NULL;

CREATE TABLE "EconomyVirtualAccountManager" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "addedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualAccountManager_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EconomyVirtualAccountManager"
    ADD CONSTRAINT "EconomyVirtualAccountManager_account_fkey"
    FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "EconomyVirtualAccountManager_account_user_key"
    ON "EconomyVirtualAccountManager"("accountId", "userDiscordId");
CREATE INDEX "EconomyVirtualAccountManager_scope_user_idx"
    ON "EconomyVirtualAccountManager"("guildId", "nitradoConnId", "userDiscordId");

CREATE TABLE "EconomyVirtualManagerPanel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "updatedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualManagerPanel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EconomyVirtualManagerPanel_scope_key"
    ON "EconomyVirtualManagerPanel"("guildId", "nitradoConnId");
CREATE UNIQUE INDEX "EconomyVirtualManagerPanel_message_key"
    ON "EconomyVirtualManagerPanel"("messageId") WHERE "messageId" IS NOT NULL;

-- Nur von V-Bot verwaltete User-Overwrites werden hier getrackt. Beim Entfernen
-- eines Kontoverwalters duerfen niemals fremde/manuell angelegte Channel-
-- Overwrites geloescht werden.
CREATE TABLE "EconomyVirtualManagerPanelAccess" (
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyVirtualManagerPanelAccess_pkey" PRIMARY KEY ("guildId", "nitradoConnId", "userDiscordId")
);
CREATE INDEX "EconomyVirtualManagerPanelAccess_channel_idx"
    ON "EconomyVirtualManagerPanelAccess"("guildId", "nitradoConnId", "channelId");

-- Backfill fuer alle bestehenden CUSTOM-, LOTTERY_POT- und MARKET_VENDOR-Konten.
-- Die jeweilige Server-Economy-Waehrung wird als 1:1-Ausgangswert uebernommen;
-- ein abweichender Kurs wird niemals implizit erzeugt.
INSERT INTO "EconomyVirtualAccountFinance" (
  "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName",
  "currencyEmoji", "accountEmoji", "accountPurpose", "createdAt", "updatedAt"
)
SELECT
  v."id", v."guildId", v."nitradoConnId", 0,
  COALESCE(c."currencyName", 'Coins'), COALESCE(c."emoji", '💰'),
  CASE
    WHEN v."kind"::text='LOTTERY_POT' THEN '🎟️'
    WHEN v."kind"::text='MARKET_VENDOR' THEN '🏴'
    ELSE '🏦'
  END,
  'GENERAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "EconomyVirtualAccount" v
LEFT JOIN "EconomyConfig" c
  ON c."guildId"=v."guildId" AND c."nitradoConnId"=v."nitradoConnId"
ON CONFLICT ("accountId") DO NOTHING;
