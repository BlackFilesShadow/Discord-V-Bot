import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const migrationName = '20260817135600_db2_composite_scope_fks';
const migrationsRoot = path.join(repoRoot, 'prisma/migrations');
const migrationPath = path.join(migrationsRoot, migrationName, 'migration.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

const protectedConstraints = [
  'ServerSettings_nitrado_scope_fkey',
  'Faction_nitrado_scope_fkey',
  'FactionSystemConfig_nitrado_scope_fkey',
  'WhitelistEntry_nitrado_scope_fkey',
  'WhitelistRequest_nitrado_scope_fkey',
  'NitradoJob_nitrado_scope_fkey',
  'NitradoAdmCursor_nitrado_scope_fkey',
  'NitradoSnapshot_nitrado_scope_fkey',
  'KillfeedConfig_nitrado_scope_fkey',
  'KillfeedEvent_nitrado_scope_fkey',
  'EconomyVirtualAccountEntry_account_scope_fkey',
  'LotteryRound_pot_scope_fkey',
  'LotteryEntry_round_scope_fkey',
  'LotteryPurchase_round_scope_fkey',
  'CasinoRound_game_guild_fkey',
  'CasinoRound_game_scope_fkey',
  'TicketInstance_template_guild_fkey',
];

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

    // Guild bleibt auch fuer kontrollierte Legacy-NULL-Server-Scope-Zeilen hart.
    expect(sql).toMatch(
      /FOREIGN KEY \("gameId", "guildId"\)\s+REFERENCES "CasinoGame"\("id", "guildId"\)/m,
    );
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
      'CasinoGame_id_guild_key',
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

  test('later migrations cannot silently drop the DB-2 scope boundary', () => {
    const laterSql = fs.readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name > migrationName)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const file = path.join(migrationsRoot, entry.name, 'migration.sql');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      })
      .join('\n');

    for (const constraint of protectedConstraints) {
      const escaped = constraint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const drop = new RegExp(`DROP\\s+CONSTRAINT(?:\\s+IF\\s+EXISTS)?\\s+"${escaped}"`, 'i');
      const reAdd = new RegExp(`ADD\\s+CONSTRAINT\\s+"${escaped}"`, 'i');
      if (drop.test(laterSql)) expect(reAdd.test(laterSql)).toBe(true);
    }
  });
});
