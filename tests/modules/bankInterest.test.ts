/**
 * Phase 5: Bank-Zinsen. Tagesidempotent — derselbe Tag zahlt NIE doppelt.
 */
import {
  computeInterest, interestDateKey, runDailyInterestForGuild,
  type BankInterestClient, type InterestAccountRow,
} from '../../src/modules/economy/bankInterest';
import type { LedgerTx } from '../../src/modules/economy/ledger';

describe('computeInterest', () => {
  it('rundet ab', () => {
    expect(computeInterest(1000n, 5)).toBe(50n);
    expect(computeInterest(199n, 5)).toBe(9n); // 9.95 -> 9
  });
  it('0 bei nicht-positivem Guthaben oder Prozent', () => {
    expect(computeInterest(0n, 5)).toBe(0n);
    expect(computeInterest(1000n, 0)).toBe(0n);
    expect(computeInterest(-100n, 5)).toBe(0n);
  });
});

describe('interestDateKey', () => {
  it('liefert YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 7, 1, 10, 0, 0));
    expect(interestDateKey(d, 'Europe/Berlin')).toBe('2026-08-01');
  });
});

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }

function makeClient(accountsInit: InterestAccountRow[]) {
  const ledgerKeys = new Set<string>();
  const runs = new Set<string>();
  const accounts = new Map<string, Account>();
  for (const a of accountsInit) accounts.set(`g:${a.userDiscordId}`, { walletBalance: 0n, bankBalance: a.bankBalance, lifetimeEarned: 0n, lifetimeSpent: 0n });

  const client: BankInterestClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) { const e = new Error('u') as Error & { code: string }; e.code = 'P2002'; throw e; }
            ledgerKeys.add(key);
            return { id: 'l-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const w = where.guildId_userDiscordId as { guildId: string; userDiscordId: string };
            const k = `${w.guildId}:${w.userDiscordId}`;
            if (!accounts.has(k)) accounts.set(k, { walletBalance: create.walletBalance as bigint, bankBalance: create.bankBalance as bigint, lifetimeEarned: 0n, lifetimeSpent: 0n });
            else accounts.get(k)!.bankBalance += (update.bankBalance as { increment: bigint }).increment;
            return accounts.get(k);
          },
        },
      };
      return fn(tx);
    },
    bankInterestRun: {
      findUnique: async (args: unknown) => {
        const rd = (args as { where: { guildId_runDate: { runDate: string } } }).where.guildId_runDate.runDate;
        return runs.has(rd) ? { id: rd } : null;
      },
      create: async ({ data }) => { runs.add(data.runDate as string); return {}; },
    },
    economyAccount: {
      findMany: async () => accountsInit,
      upsert: async () => ({}),
    },
  };
  return { client, accounts };
}

describe('runDailyInterestForGuild — Tagesidempotenz', () => {
  it('schreibt Zinsen auf die Bank gut', async () => {
    const { client, accounts } = makeClient([{ userDiscordId: 'u1', bankBalance: 1000n }]);
    const r = await runDailyInterestForGuild(client, { guildId: 'g', percent: 5, runDate: '2026-08-01' });
    expect(r.credited).toBe(1);
    expect(r.total).toBe(50n);
    expect(accounts.get('g:u1')!.bankBalance).toBe(1050n);
  });

  it('zweiter Lauf am selben Tag ist No-op', async () => {
    const { client, accounts } = makeClient([{ userDiscordId: 'u1', bankBalance: 1000n }]);
    await runDailyInterestForGuild(client, { guildId: 'g', percent: 5, runDate: '2026-08-01' });
    const r2 = await runDailyInterestForGuild(client, { guildId: 'g', percent: 5, runDate: '2026-08-01' });
    expect(r2.skipped).toBe(true);
    expect(accounts.get('g:u1')!.bankBalance).toBe(1050n);
  });

  it('percent<=0 -> skipped', async () => {
    const { client } = makeClient([{ userDiscordId: 'u1', bankBalance: 1000n }]);
    const r = await runDailyInterestForGuild(client, { guildId: 'g', percent: 0, runDate: '2026-08-01' });
    expect(r.skipped).toBe(true);
  });
});
