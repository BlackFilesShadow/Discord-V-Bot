import fs from 'fs';
import path from 'path';
import {
  CASINO_GAME_TYPES,
  MAX_CASINO_BET,
  assertCasinoEconomySafe,
  casinoDefaults,
  payoutMultiplierMilli,
  theoreticalCasinoRtpPct,
} from '../../src/modules/economy/casinoRules';
import { casinoDefinition, normalizeCasinoPayoutMultiplier } from '../../src/modules/economy/casinoRegistry';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EXPECTED = ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK', 'ROULETTE', 'HIGHLOW', 'BACCARAT', 'WHEEL'] as const;

describe('casino V3 hardening contracts', () => {
  it('registers exactly the eight public game types with safe defaults', () => {
    expect(CASINO_GAME_TYPES).toEqual(EXPECTED);
    for (const type of EXPECTED) {
      const defaults = casinoDefaults(type);
      expect(defaults.enabled).toBe(false);
      expect(defaults.cooldownSeconds).toBeGreaterThanOrEqual(0);
      expect(theoreticalCasinoRtpPct(type, defaults.winChancePct, defaults.payoutMult)).toBeLessThanOrEqual(100);
      expect(casinoDefinition(type).command.length).toBeGreaterThan(0);
    }
  });

  it('rejects configurations that can print money including draw-aware games', () => {
    expect(() => assertCasinoEconomySafe('SLOT', 99, 2)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('ROULETTE', 60, 2)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('BLACKJACK', 50, 2)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('BACCARAT', 50, 2)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('COINFLIP', 48, 2)).not.toThrow();
  });

  it('uses one canonical milli precision for dashboard RTP, persistence and payouts', () => {
    expect(normalizeCasinoPayoutMultiplier(1.23449)).toBe(1.234);
    expect(normalizeCasinoPayoutMultiplier(1.2345)).toBe(1.235);
    expect(payoutMultiplierMilli(1.23449)).toBe(1234);
    expect(theoreticalCasinoRtpPct('SLOT', 50, 1.23449)).toBeCloseTo(61.7, 8);
  });

  it('keeps Discord and dashboard bet ceilings on the same canonical limit', () => {
    expect(MAX_CASINO_BET).toBe(1_000_000_000_000_000n);
    const casino = read('src/commands/dashboard/casino.ts');
    const route = read('src/dashboard/routes/v2/casino.ts');
    expect(casino).toContain('Number(MAX_CASINO_BET)');
    expect(route).toContain('MAX_CASINO_BET');
    expect(casino).not.toContain('.setMaxValue(1_000_000)');
  });

  it('persists V3 config in a dedicated scoped model with slot-deletion lifecycle', () => {
    const schema = read('prisma/casino-v3.prisma');
    const migration = read('prisma/migrations/20260908001000_casino_v3_scoped_config/migration.sql');
    const registry = read('src/modules/economy/casinoRegistry.ts');
    expect(schema).toContain('model CasinoGameConfigV3');
    expect(schema).toContain('@@unique([guildId, nitradoConnId, type]');
    expect(registry).toContain('prisma.casinoGameConfigV3.findUnique');
    expect(registry).toContain('tx.casinoGameConfigV3.upsert');
    expect(registry).not.toContain('prisma.botConfig');
    expect(migration).toContain('NitradoConnection_delete_casino_v3_config');
    expect(migration).toContain('BEFORE DELETE ON "NitradoConnection"');
  });

  it('books decided rounds gross through the central ledger and keeps draws lifetime-neutral', () => {
    const casino = read('src/commands/dashboard/casino.ts');
    expect(casino).toContain('bookCasinoLedger');
    expect(casino).toContain('`casino:round:${args.roundId}:bet`');
    expect(casino).toContain('`casino:round:${args.roundId}:payout`');
    expect(casino).toContain('`casino:round:${args.roundId}:draw`');
    expect(casino).toContain('walletDelta: 0n');
    expect(casino).toContain('walletDelta: -args.bet');
    expect(casino).toContain('walletDelta: args.result.payout');
    expect(casino).not.toContain('const net = result.payout - args.bet');
  });

  it('serializes configurable cooldowns in PostgreSQL and acknowledges Discord before money', () => {
    const casino = read('src/commands/dashboard/casino.ts');
    expect(casino).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(casino).toContain('config.cooldownSeconds * 1000');
    expect(casino).toContain('await i.deferReply()');
    expect(casino).toContain('await i.editReply({');
  });

  it('stores immutable V3 rules, random nonce and fails malformed audit snapshots closed', () => {
    const casino = read('src/commands/dashboard/casino.ts');
    expect(casino).not.toContain('SELECT COUNT(*)::bigint AS "count" FROM "CasinoRound"');
    expect(casino).toContain('randomNonce()');
    expect(casino).toContain('CASINO_ALGORITHM_VERSION');
    expect(casino).toContain('payoutMultMilli');
    expect(casino).toContain(".setName('casino-verify')");
    expect(casino).toContain("kind: 'invalid'");
    expect(casino).toContain('Audit-Snapshot ungueltig');
    expect(casino).toContain('betBoundsMatch');
  });

  it('aggregates logical V3 game types without a silent history cap', () => {
    const casinoRoute = read('src/dashboard/routes/v2/casino.ts');
    const economyRoute = read('src/dashboard/routes/v2/economy.ts');
    expect(casinoRoute).toContain("result\"->'audit'->>'type'");
    expect(economyRoute).toContain("result\"->'audit'->>'type'");
    expect(casinoRoute).not.toContain('take: 100_000');
    expect(economyRoute).not.toContain('LIMIT 100000');
  });

  it('never re-labels a malformed audited V3 round through its shared legacy anchor', () => {
    const casinoRoute = read('src/dashboard/routes/v2/casino.ts');
    const economyRoute = read('src/dashboard/routes/v2/economy.ts');
    expect(casinoRoute).toContain("Object.prototype.hasOwnProperty.call(row, 'audit')");
    expect(casinoRoute).toContain("type: type ?? 'UNKNOWN'");
    expect(casinoRoute).toContain('auditedTypeIsValid(row.type, row.algorithmVersion)');
    expect(casinoRoute).toContain("CASE WHEN r.\"result\" ? 'audit'");
    expect(casinoRoute).not.toContain("COALESCE(r.\"result\"->'audit'->>'type', g.\"type\"::text)");
    expect(economyRoute).toContain('auditedCasinoTypeIsValid(row.type, row.algorithmVersion)');
    expect(economyRoute).toContain('classifiedCasinoStats');
    expect(economyRoute).not.toContain("COALESCE(r.\"result\"->'audit'->>'type', g.\"type\"::text)");
  });
});
