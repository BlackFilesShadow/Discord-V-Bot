-- DB-2: Datenbank-Invarianten fuer Guild/Gameserver-Scope.
--
-- Ziel: Eine gueltige Fremdschluessel-ID allein darf niemals ausreichen, um
-- einen Datensatz aus einer anderen Guild bzw. einem anderen Gameserver zu
-- referenzieren. Bestehende Daten werden vor jeder Constraint-Aenderung
-- fail-closed geprueft. Bei Inkonsistenzen bricht die Migration ab; es wird
-- nichts geraten, umgeschrieben oder geloescht.

-- Referenzierte Composite-Keys. Die erste Spalte bleibt die kanonische ID;
-- Guild/Gameserver sind zusaetzliche Integritaetsgrenzen.
CREATE UNIQUE INDEX IF NOT EXISTS "NitradoConnection_id_guild_key"
  ON "NitradoConnection"("id", "guildId");
CREATE UNIQUE INDEX IF NOT EXISTS "EconomyVirtualAccount_id_scope_key"
  ON "EconomyVirtualAccount"("id", "guildId", "nitradoConnId");
CREATE UNIQUE INDEX IF NOT EXISTS "LotteryRound_id_scope_key"
  ON "LotteryRound"("id", "guildId", "nitradoConnId");
CREATE UNIQUE INDEX IF NOT EXISTS "CasinoGame_id_guild_key"
  ON "CasinoGame"("id", "guildId");
CREATE UNIQUE INDEX IF NOT EXISTS "CasinoGame_id_scope_key"
  ON "CasinoGame"("id", "guildId", "nitradoConnId");
CREATE UNIQUE INDEX IF NOT EXISTS "TicketTemplate_id_guild_key"
  ON "TicketTemplate"("id", "guildId");

-- Upgrade-Schutz: vorhandene Cross-Scope-/Orphan-Zeilen duerfen nicht still
-- durch neue FKs verdeckt, repariert oder geloescht werden.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ServerSettings" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: ServerSettings -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Faction" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE c."nitradoConnId" IS NOT NULL AND (p."id" IS NULL OR p."guildId" <> c."guildId")
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: Faction -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "FactionSystemConfig" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE c."nitradoConnId" IS NOT NULL AND (p."id" IS NULL OR p."guildId" <> c."guildId")
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: FactionSystemConfig -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "WhitelistEntry" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: WhitelistEntry -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "WhitelistRequest" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: WhitelistRequest -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "NitradoJob" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: NitradoJob -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "NitradoAdmCursor" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: NitradoAdmCursor -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "NitradoSnapshot" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: NitradoSnapshot -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "KillfeedConfig" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: KillfeedConfig -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "KillfeedEvent" c
    LEFT JOIN "NitradoConnection" p ON p."id" = c."nitradoConnId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: KillfeedEvent -> NitradoConnection'; END IF;

  IF EXISTS (
    SELECT 1 FROM "EconomyVirtualAccountEntry" c
    LEFT JOIN "EconomyVirtualAccount" p ON p."id" = c."virtualAccountId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId" OR p."nitradoConnId" <> c."nitradoConnId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: EconomyVirtualAccountEntry -> EconomyVirtualAccount'; END IF;

  IF EXISTS (
    SELECT 1 FROM "LotteryRound" c
    LEFT JOIN "EconomyVirtualAccount" p ON p."id" = c."potAccountId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId" OR p."nitradoConnId" <> c."nitradoConnId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: LotteryRound -> EconomyVirtualAccount'; END IF;

  IF EXISTS (
    SELECT 1 FROM "LotteryEntry" c
    LEFT JOIN "LotteryRound" p ON p."id" = c."roundId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId" OR p."nitradoConnId" <> c."nitradoConnId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: LotteryEntry -> LotteryRound'; END IF;

  IF EXISTS (
    SELECT 1 FROM "LotteryPurchase" c
    LEFT JOIN "LotteryRound" p ON p."id" = c."roundId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId" OR p."nitradoConnId" <> c."nitradoConnId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: LotteryPurchase -> LotteryRound'; END IF;

  -- Legacy-Casino-Zeilen duerfen NULL-Gameserver-Scope behalten, die Guild muss
  -- jedoch immer passen. Sobald ein Gameserver gesetzt ist, muss auch dieser
  -- exakt dem referenzierten Game entsprechen.
  IF EXISTS (
    SELECT 1 FROM "CasinoRound" c
    LEFT JOIN "CasinoGame" p ON p."id" = c."gameId"
    WHERE p."id" IS NULL
       OR p."guildId" <> c."guildId"
       OR (c."nitradoConnId" IS NOT NULL
           AND (p."nitradoConnId" IS NULL OR p."nitradoConnId" <> c."nitradoConnId"))
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: CasinoRound -> CasinoGame'; END IF;

  IF EXISTS (
    SELECT 1 FROM "TicketInstance" c
    LEFT JOIN "TicketTemplate" p ON p."id" = c."templateId"
    WHERE p."id" IS NULL OR p."guildId" <> c."guildId"
  ) THEN RAISE EXCEPTION 'DB-2 invariant violation: TicketInstance -> TicketTemplate'; END IF;
END $$;

-- Nitrado: die Guild ist Bestandteil jedes direkten Connection-FKs.
ALTER TABLE "ServerSettings" DROP CONSTRAINT IF EXISTS "ServerSettings_nitradoConnId_fkey";
ALTER TABLE "ServerSettings" ADD CONSTRAINT "ServerSettings_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Faction" DROP CONSTRAINT IF EXISTS "Faction_nitradoConnId_fkey";
ALTER TABLE "Faction" ADD CONSTRAINT "Faction_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FactionSystemConfig" DROP CONSTRAINT IF EXISTS "FactionSystemConfig_nitradoConnId_fkey";
ALTER TABLE "FactionSystemConfig" ADD CONSTRAINT "FactionSystemConfig_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhitelistEntry" DROP CONSTRAINT IF EXISTS "WhitelistEntry_nitradoConnId_fkey";
ALTER TABLE "WhitelistEntry" ADD CONSTRAINT "WhitelistEntry_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhitelistRequest" DROP CONSTRAINT IF EXISTS "WhitelistRequest_nitradoConnId_fkey";
ALTER TABLE "WhitelistRequest" ADD CONSTRAINT "WhitelistRequest_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NitradoJob" DROP CONSTRAINT IF EXISTS "NitradoJob_nitradoConnId_fkey";
ALTER TABLE "NitradoJob" ADD CONSTRAINT "NitradoJob_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NitradoAdmCursor" DROP CONSTRAINT IF EXISTS "NitradoAdmCursor_nitradoConnId_fkey";
ALTER TABLE "NitradoAdmCursor" ADD CONSTRAINT "NitradoAdmCursor_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NitradoSnapshot" DROP CONSTRAINT IF EXISTS "NitradoSnapshot_nitradoConnId_fkey";
ALTER TABLE "NitradoSnapshot" ADD CONSTRAINT "NitradoSnapshot_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KillfeedConfig" DROP CONSTRAINT IF EXISTS "KillfeedConfig_nitradoConnId_fkey";
ALTER TABLE "KillfeedConfig" ADD CONSTRAINT "KillfeedConfig_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KillfeedEvent" DROP CONSTRAINT IF EXISTS "KillfeedEvent_nitradoConnId_fkey";
ALTER TABLE "KillfeedEvent" ADD CONSTRAINT "KillfeedEvent_nitrado_scope_fkey"
  FOREIGN KEY ("nitradoConnId", "guildId") REFERENCES "NitradoConnection"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Economy: Child und Parent muessen dieselbe Guild UND denselben Gameserver
-- tragen. Damit kann keine gueltige ID einen Cross-Scope-Verweis erzeugen.
ALTER TABLE "EconomyVirtualAccountEntry" DROP CONSTRAINT IF EXISTS "EconomyVirtualAccountEntry_virtualAccountId_fkey";
ALTER TABLE "EconomyVirtualAccountEntry" ADD CONSTRAINT "EconomyVirtualAccountEntry_account_scope_fkey"
  FOREIGN KEY ("virtualAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryRound" DROP CONSTRAINT IF EXISTS "LotteryRound_potAccountId_fkey";
ALTER TABLE "LotteryRound" ADD CONSTRAINT "LotteryRound_pot_scope_fkey"
  FOREIGN KEY ("potAccountId", "guildId", "nitradoConnId")
  REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryEntry" DROP CONSTRAINT IF EXISTS "LotteryEntry_roundId_fkey";
ALTER TABLE "LotteryEntry" ADD CONSTRAINT "LotteryEntry_round_scope_fkey"
  FOREIGN KEY ("roundId", "guildId", "nitradoConnId")
  REFERENCES "LotteryRound"("id", "guildId", "nitradoConnId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LotteryPurchase" DROP CONSTRAINT IF EXISTS "LotteryPurchase_roundId_fkey";
ALTER TABLE "LotteryPurchase" ADD CONSTRAINT "LotteryPurchase_round_scope_fkey"
  FOREIGN KEY ("roundId", "guildId", "nitradoConnId")
  REFERENCES "LotteryRound"("id", "guildId", "nitradoConnId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CasinoRound" DROP CONSTRAINT IF EXISTS "CasinoRound_gameId_fkey";
ALTER TABLE "CasinoRound" ADD CONSTRAINT "CasinoRound_game_guild_fkey"
  FOREIGN KEY ("gameId", "guildId")
  REFERENCES "CasinoGame"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CasinoRound" ADD CONSTRAINT "CasinoRound_game_scope_fkey"
  FOREIGN KEY ("gameId", "guildId", "nitradoConnId")
  REFERENCES "CasinoGame"("id", "guildId", "nitradoConnId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Discord-Tickets: templateId muss aus derselben Guild stammen.
ALTER TABLE "TicketInstance" DROP CONSTRAINT IF EXISTS "TicketInstance_templateId_fkey";
ALTER TABLE "TicketInstance" ADD CONSTRAINT "TicketInstance_template_guild_fkey"
  FOREIGN KEY ("templateId", "guildId") REFERENCES "TicketTemplate"("id", "guildId") ON DELETE CASCADE ON UPDATE CASCADE;
