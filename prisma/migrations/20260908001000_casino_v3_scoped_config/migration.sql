-- Casino V3: dedicated Guild+Gameserver-scoped configuration.
-- Public game identity intentionally remains a validated VARCHAR instead of
-- extending the historic CasinoGameType enum. Historic CasinoRound FKs stay
-- untouched; V3 rounds carry their logical type in result.audit.type.

CREATE TABLE "CasinoGameConfigV3" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "nitradoConnId" TEXT NOT NULL,
    "type" VARCHAR(24) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "winChancePct" INTEGER NOT NULL,
    "minBet" BIGINT NOT NULL DEFAULT 1,
    "maxBet" BIGINT NOT NULL DEFAULT 10000,
    "payoutMult" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasinoGameConfigV3_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CasinoGameConfigV3_type_check" CHECK ("type" IN ('SLOT','COINFLIP','DICE','BLACKJACK','ROULETTE','HIGHLOW','BACCARAT','WHEEL')),
    CONSTRAINT "CasinoGameConfigV3_win_check" CHECK ("winChancePct" BETWEEN 1 AND 99),
    CONSTRAINT "CasinoGameConfigV3_bet_check" CHECK ("minBet" >= 1 AND "maxBet" >= "minBet" AND "maxBet" <= 1000000000000000),
    CONSTRAINT "CasinoGameConfigV3_payout_check" CHECK ("payoutMult" >= 1 AND "payoutMult" <= 100),
    CONSTRAINT "CasinoGameConfigV3_cooldown_check" CHECK ("cooldownSeconds" BETWEEN 0 AND 3600)
);

CREATE UNIQUE INDEX "CasinoGameConfigV3_guild_conn_type_key"
    ON "CasinoGameConfigV3"("guildId", "nitradoConnId", "type");
CREATE INDEX "CasinoGameConfigV3_guild_conn_idx"
    ON "CasinoGameConfigV3"("guildId", "nitradoConnId");

-- Prisma schema files cannot extend the existing NitradoConnection model from
-- another file, so the connection lifecycle is enforced with a DB trigger.
-- This keeps slot deletion atomic and prevents orphaned V3 configurations while
-- avoiding an unsafe full rewrite of the legacy schema model.
CREATE OR REPLACE FUNCTION "vbot_delete_casino_v3_config_for_connection"()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM "CasinoGameConfigV3"
     WHERE "guildId" = OLD."guildId"
       AND "nitradoConnId" = OLD."id";
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "NitradoConnection_delete_casino_v3_config" ON "NitradoConnection";
CREATE TRIGGER "NitradoConnection_delete_casino_v3_config"
BEFORE DELETE ON "NitradoConnection"
FOR EACH ROW
EXECUTE FUNCTION "vbot_delete_casino_v3_config_for_connection"();
