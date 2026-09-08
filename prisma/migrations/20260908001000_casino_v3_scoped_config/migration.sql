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

-- Multi-file Prisma cannot add the inverse relation to the existing legacy
-- NitradoConnection model without rewriting that model. Enforce the same
-- boundary directly in PostgreSQL: a V3 config must always point to an existing
-- connection of the SAME guild. This also protects direct SQL/import paths that
-- bypass the dashboard/Prisma scope guards.
CREATE OR REPLACE FUNCTION "vbot_validate_casino_v3_connection_scope"()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM "NitradoConnection" n
         WHERE n."id" = NEW."nitradoConnId"
           AND n."guildId" = NEW."guildId"
    ) THEN
        RAISE EXCEPTION 'CasinoGameConfigV3 references missing or cross-guild NitradoConnection (%/%)', NEW."guildId", NEW."nitradoConnId"
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "CasinoGameConfigV3_validate_connection_scope" ON "CasinoGameConfigV3";
CREATE TRIGGER "CasinoGameConfigV3_validate_connection_scope"
BEFORE INSERT OR UPDATE OF "guildId", "nitradoConnId" ON "CasinoGameConfigV3"
FOR EACH ROW
EXECUTE FUNCTION "vbot_validate_casino_v3_connection_scope"();

-- Keep connection deletion atomic with the V3 configuration lifecycle. The
-- cleanup happens before NitradoConnection disappears, so no orphan window can
-- be observed even by raw SQL readers.
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
