import fs from 'node:fs';
import path from 'node:path';
import {
  bookLedgerEntryInTx,
  EconomyLedgerRangeError,
  POSTGRES_BIGINT_MAX,
  type LedgerTx,
} from '../../src/modules/economy/ledger';

const INPUT = {
  idempotencyKey: 'range:test',
  guildId: '123456789012345678',
  nitradoConnId: 'conn-1',
  userDiscordId: '223456789012345678',
  type: 'GRANT',
};

function fullTx(snapshot: {
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}) {
  let ledgerCreates = 0;
  let accountWrites = 0;
  const tx: LedgerTx = {
    $queryRawUnsafe: async <T = unknown>(query: string): Promise<T> => {
      if (!query.includes('FROM "EconomyAccount"') || !query.includes('FOR UPDATE')) {
        throw new Error(`unexpected query: ${query}`);
      }
      return [snapshot] as T;
    },
    $executeRawUnsafe: async () => 0,
    economyLedgerEntry: {
      create: async () => {
        ledgerCreates++;
        return { id: 'ledger-1' };
      },
    },
    economyAccount: {
      upsert: async () => {
        accountWrites++;
        return {};
      },
    },
  };
  return {
    tx,
    ledgerCreates: () => ledgerCreates,
    accountWrites: () => accountWrites,
  };
}

describe('central economy ledger bigint range fence', () => {
  it('rejects cumulative account overflow before ledger/account writes', async () => {
    const state = fullTx({
      walletBalance: POSTGRES_BIGINT_MAX - 50n,
      bankBalance: 0n,
      lifetimeEarned: POSTGRES_BIGINT_MAX - 50n,
      lifetimeSpent: 0n,
    });

    await expect(bookLedgerEntryInTx(state.tx, { ...INPUT, walletDelta: 100n }))
      .rejects.toBeInstanceOf(EconomyLedgerRangeError);
    expect(state.ledgerCreates()).toBe(0);
    expect(state.accountWrites()).toBe(0);
  });

  it('allows the exact PostgreSQL BIGINT boundary', async () => {
    const state = fullTx({
      walletBalance: POSTGRES_BIGINT_MAX - 100n,
      bankBalance: 0n,
      lifetimeEarned: POSTGRES_BIGINT_MAX - 100n,
      lifetimeSpent: 0n,
    });

    await expect(bookLedgerEntryInTx(state.tx, { ...INPUT, walletDelta: 100n }))
      .resolves.toEqual({ entryId: 'ledger-1' });
    expect(state.ledgerCreates()).toBe(1);
    expect(state.accountWrites()).toBe(1);
  });

  it('rejects an individually unrepresentable delta even on a narrow client', async () => {
    const tx: LedgerTx = {
      economyLedgerEntry: { create: async () => ({ id: 'never' }) },
      economyAccount: { upsert: async () => ({}) },
    };
    await expect(bookLedgerEntryInTx(tx, { ...INPUT, walletDelta: POSTGRES_BIGINT_MAX + 1n }))
      .rejects.toBeInstanceOf(EconomyLedgerRangeError);
  });

  it('finalizes automatic reward saturation instead of creating retry loops', () => {
    const reward = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/economy/rewardBooking.ts'), 'utf8');
    const playtime = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/economy/playtimeBooking.ts'), 'utf8');
    expect(reward).toContain("'SKIPPED_BALANCE_LIMIT'");
    expect(reward).toContain('error instanceof EconomyLedgerRangeError');
    expect(playtime).toContain('error instanceof EconomyLedgerRangeError');
    expect(playtime).toMatch(/EconomyLedgerRangeError[\s\S]*persistProgress\(tx, scope, session\.id, link, eligibleBuckets\)/);
  });
});
