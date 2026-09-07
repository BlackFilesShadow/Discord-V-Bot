import fs from 'fs';
import path from 'path';
import {
  MAX_CASINO_BET,
  assertCasinoEconomySafe,
  casinoDefaults,
  theoreticalCasinoRtpPct,
} from '../../src/modules/economy/casinoRules';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('casino hardening contracts', () => {
  it('uses safe type-specific defaults instead of one generic payout', () => {
    expect(casinoDefaults('SLOT')).toMatchObject({ enabled: false, winChancePct: 45, payoutMult: 2 });
    expect(casinoDefaults('COINFLIP').payoutMult).toBe(1.9);
    expect(casinoDefaults('DICE').payoutMult).toBe(5.5);
    expect(casinoDefaults('BLACKJACK').payoutMult).toBe(2);

    for (const type of ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK'] as const) {
      const defaults = casinoDefaults(type);
      expect(theoreticalCasinoRtpPct(type, defaults.winChancePct, defaults.payoutMult)).toBeLessThanOrEqual(100);
    }
  });

  it('rejects configurations that can print money through negative house edge', () => {
    expect(() => assertCasinoEconomySafe('COINFLIP', 50, 2.01)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('DICE', 17, 6.1)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('SLOT', 99, 100)).toThrow(/RTP/);
    expect(() => assertCasinoEconomySafe('COINFLIP', 50, 2)).not.toThrow();
  });

  it('keeps Discord and dashboard bet ceilings on the same canonical limit', () => {
    expect(MAX_CASINO_BET).toBe(1_000_000_000_000_000n);
    const casino = read('src/commands/dashboard/casino.ts');
    const route = read('src/dashboard/routes/v2/casino.ts');
    expect(casino).toContain('Number(MAX_CASINO_BET)');
    expect(route).toContain('MAX_CASINO_BET');
    expect(casino).not.toContain('.setMaxValue(1_000_000)');
  });

  it('removes count-based nonces, snapshots rules and exposes post-round verification', () => {
    const casino = read('src/commands/dashboard/casino.ts');
    expect(casino).not.toContain('SELECT COUNT(*)::bigint AS "count" FROM "CasinoRound"');
    expect(casino).toContain('randomNonce()');
    expect(casino).toContain('CASINO_ALGORITHM_VERSION');
    expect(casino).toContain('payoutMultMilli');
    expect(casino).toContain(".setName('casino-verify')");
    expect(casino).toContain('serverSeedHash: seedHashFull(serverSeed)');
  });

  it('aggregates casino statistics in SQL without a silent 100k history cap', () => {
    const casinoRoute = read('src/dashboard/routes/v2/casino.ts');
    const economyRoute = read('src/dashboard/routes/v2/economy.ts');
    expect(casinoRoute).toContain('GROUP BY g."type"');
    expect(economyRoute).toContain('GROUP BY g."type"');
    expect(casinoRoute).not.toContain('take: 100_000');
    expect(economyRoute).not.toContain('LIMIT 100000');
  });

  it('adds anti-spam cooldowns to all four money-playing commands', () => {
    const casino = read('src/commands/dashboard/casino.ts');
    const matches = casino.match(/cooldown: 2,/g) ?? [];
    expect(matches).toHaveLength(4);
  });
});
