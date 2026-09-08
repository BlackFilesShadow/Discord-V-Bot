import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const migration = normalizeSourceNewlines(fs.readFileSync(
  path.resolve(process.cwd(), 'prisma/migrations/20260908001000_casino_v3_scoped_config/migration.sql'),
  'utf8',
));

describe('Casino V3 config database scope gate', () => {
  it('validates Guild + Nitrado connection identity before every scoped write', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "vbot_validate_casino_v3_connection_scope"()');
    expect(migration).toContain('FROM "NitradoConnection" n');
    expect(migration).toContain('n."id" = NEW."nitradoConnId"');
    expect(migration).toContain('n."guildId" = NEW."guildId"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF "guildId", "nitradoConnId" ON "CasinoGameConfigV3"');
    expect(migration).toContain("USING ERRCODE = '23503'");
  });

  it('removes only the exact Guild + connection configuration during slot deletion', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "vbot_delete_casino_v3_config_for_connection"()');
    expect(migration).toContain('WHERE "guildId" = OLD."guildId"');
    expect(migration).toContain('AND "nitradoConnId" = OLD."id"');
    expect(migration).toContain('BEFORE DELETE ON "NitradoConnection"');
  });

  it('keeps the public game type and money bounds database-enforced', () => {
    for (const type of ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK', 'ROULETTE', 'HIGHLOW', 'BACCARAT', 'WHEEL']) {
      expect(migration).toContain(`'${type}'`);
    }
    expect(migration).toContain('CONSTRAINT "CasinoGameConfigV3_win_check"');
    expect(migration).toContain('CONSTRAINT "CasinoGameConfigV3_bet_check"');
    expect(migration).toContain('CONSTRAINT "CasinoGameConfigV3_payout_check"');
    expect(migration).toContain('CONSTRAINT "CasinoGameConfigV3_cooldown_check"');
  });
});
