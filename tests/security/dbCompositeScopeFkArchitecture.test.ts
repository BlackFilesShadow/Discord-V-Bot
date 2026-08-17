import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const migrationPath = path.join(
  repoRoot,
  'prisma/migrations/20260817135600_db2_composite_scope_fks/migration.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

describe('DB-2 composite tenant foreign-key invariants', () => {
  test('fails closed on existing inconsistent data before changing foreign keys', () => {
    const preflight = sql.indexOf('DO $$');
    const firstDrop = sql.indexOf('DROP CONSTRAINT');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(firstDrop).toBeGreaterThan(preflight);
    expect(sql).toContain("RAISE EXCEPTION 'DB-2 invariant violation: ServerSettings -> NitradoConnection'");
    expect(sql).toContain("RAISE EXCEPTION 'DB-2 invariant violation: EconomyVirtualAccountEntry -> EconomyVirtualAccount'");
    expect(sql).toContain("RAISE EXCEPTION 'DB-2 invariant violation: LotteryEntry -> LotteryRound'");
    expect(sql).toContain("RAISE EXCEPTION 'DB-2 invariant violation: CasinoRound -> CasinoGame'");
    expect(sql).toContain("RAISE EXCEPTION 'DB-2 invariant violation: TicketInstance -> TicketTemplate'");

    // DB-2 darf bestehende Cross-Scope-Daten nie still umhaengen oder loeschen.
    expect(sql).not.toMatch(/\bUPDATE\s+"/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+"/i);
  });

  test('all direct Nitrado relations bind connection id and Guild together', () => {
    const tables = [
      'ServerSettings',
      'Faction',
      'FactionSystemConfig',
      'WhitelistEntry',
      'WhitelistRequest',
      'NitradoJob',
      'NitradoAdmCursor',
      'NitradoSnapshot',
      'KillfeedConfig',
      'KillfeedEvent',
    ];

    expect(sql).toContain('"NitradoConnection_id_guild_key"');
    for (const table of tables) {
      const relation = new RegExp(
        `ALTER TABLE "${table}" ADD CONSTRAINT "[^"]+"\\s+FOREIGN KEY \\(\"nitradoConnId\", \"guildId\"\\)\\s+REFERENCES \"NitradoConnection\"\\(\"id\", \"guildId\"\\)`,
        'm',
      );
      expect(sql).toMatch(relation);
    }
  });

  test('critical Economy child graphs cannot cross Guild or Gameserver boundaries', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("virtualAccountId", "guildId", "nitradoConnId"\)\s+REFERENCES "EconomyVirtualAccount"\("id", "guildId", "nitradoConnId"\)/m,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("potAccountId", "guildId", "nitradoConnId"\)\s+REFERENCES "EconomyVirtualAccount"\("id", "guildId", "nitradoConnId"\)/m,
    );

    const scopedRoundFks = sql.match(
      /FOREIGN KEY \("roundId", "guildId", "nitradoConnId"\)\s+REFERENCES "LotteryRound"\("id", "guildId", "nitradoConnId"\)/gm,
    );
    expect(scopedRoundFks).toHaveLength(2);

    expect(sql).toMatch(
      /FOREIGN KEY \("gameId", "guildId", "nitradoConnId"\)\s+REFERENCES "CasinoGame"\("id", "guildId", "nitradoConnId"\)/m,
    );
  });

  test('Discord ticket template relation is Guild-bound', () => {
    expect(sql).toContain('"TicketTemplate_id_guild_key"');
    expect(sql).toMatch(
      /FOREIGN KEY \("templateId", "guildId"\) REFERENCES "TicketTemplate"\("id", "guildId"\)/m,
    );
  });

  test('referenced composite keys exist before the composite foreign keys are added', () => {
    const keys = [
      'NitradoConnection_id_guild_key',
      'EconomyVirtualAccount_id_scope_key',
      'LotteryRound_id_scope_key',
      'CasinoGame_id_scope_key',
      'TicketTemplate_id_guild_key',
    ];
    const firstFkAdd = sql.indexOf('ADD CONSTRAINT "ServerSettings_nitrado_scope_fkey"');

    for (const key of keys) {
      const keyPos = sql.indexOf(`"${key}"`);
      expect(keyPos).toBeGreaterThanOrEqual(0);
      expect(keyPos).toBeLessThan(firstFkAdd);
    }
  });
});
