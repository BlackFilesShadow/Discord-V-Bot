/**
 * Phase 5 / Phase 4 scope regression: Bank-Zinsen sind pro Gameserver
 * tagesidempotent und duerfen denselben Discord-User in einer Guild nicht
 * serveruebergreifend vermischen.
 */
import {
  computeInterest, interestDateKey, runDailyInterestForServer,
  type BankInterestClient, type InterestAccountRow,
} from '../../src/modules/economy/bankInterest';
import type { LedgerTx } from '../../src/modules/economy/ledger';

describe('computeInterest', () => {
  it('rundet ab', () => {
    expect(computeInterest(1000n, 5)).toBe(50n);
    expect(computeInterest(199n, 5)).toBe(9n);
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
interface ScopedInterestAccountRow extends InterestAccountRow { guildId: string; nitradoConnId: string }

function makeClient(accountsInit: ScopedInterestAccountRow[]) {
  const ledgerKeys = new Set<string>();
  const runs = new Set<string>();
  const accounts = new Map<string, Account>();
  for (const a of accountsInit) {
    accounts.set(`${a.guildId}:${a.nitradoConnId}:${a.userDiscordId}`, {
      walletBalance: 0n,
      bankBalance: a.bankBalance,
      lifetimeEarned: 0n,
      lifetimeSpent: 0n,
    });
  }

  const client: BankInterestClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) {
              const e = new Error('u') as Error & { code: string };
              e.code = 'P2002';
              throw e;
            }
            ledgerKeys.add(key);
            return { id: 'l-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const w = where.guildServerUser as { guildId: string; nitradoConnId: string; userDiscordId: string };
            const k = `${w.guildId}:${w.nitradoConnId}:${w.userDiscordId}`;
            if (!accounts.has(k)) {
              accounts.set(k, {
                walletBalance: create.walletBalance as bigint,
                bankBalance: create.bankBalance as bigint,
                lifetimeEarned: create.lifetimeEarned as bigint,
                lifetimeSpent: create.lifetimeSpent as bigint,
              });
            } else {
              const account = accounts.get(k)!;
              account.walletBalance += (update.walletBalance as { increment: bigint }).increment;
              account.bankBalance += (update.bankBalance as { increment: bigint }).increment;
              account.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
              account.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
            }
            return accounts.get(k);
          },
        },
      };
      return fn(tx);
    },
    bankInterestRun: {
      findUnique: async (args: unknown) => {
        const w = (args as { where: { guildServerRunDate: { guildId: string; nitradoConnId: string; runDate: string } } }).where.guildServerRunDate;
        const key = `${w.guildId}:${w.nitradoConnId}:${w.runDate}`;
        return runs.has(key) ? { id: key } : null;
      },
      create: async ({ data }) => {
        runs.add(`${String(data.guildId)}:${String(data.nitradoConnId)}:${String(data.runDate)}`);
        return {};
      },
    },
    economyAccount: {
      findMany: async (args: unknown) => {
        const where = (args as { where: { guildId: string; nitradoConnId: string } }).where;
        return accountsInit
          .filter((a) => a.guildId === where.guildId && a.nitradoConnId === where.nitradoConnId && a.bankBalance > 0n)
          .map(({ userDiscordId, bankBalance }) => ({ userDiscordId, bankBalance }));
      },
      upsert: async () => ({}),
    },
  };
  return { client, accounts, runs, ledgerKeys };
}

const N1 = { guildId: 'g', nitradoConnId: 'n1', percent: 5, runDate: '2026-08-01' };
const N2 = { guildId: 'g', nitradoConnId: 'n2', percent: 5, runDate: '2026-08-01' };

describe('runDailyInterestForServer — Tagesidempotenz und Scope', () => {
  it('schreibt Zinsen nur auf den ausgewaehlten Server-Account gut', async () => {
    const { client, accounts } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
      { guildId: 'g', nitradoConnId: 'n2', userDiscordId: 'u1', bankBalance: 2000n },
    ]);
    const r = await runDailyInterestForServer(client, N1);
    expect(r.credited).toBe(1);
    expect(r.total).toBe(50n);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(accounts.get('g:n2:u1')!.bankBalance).toBe(2000n);
  });

  it('zweiter Lauf desselben Servers am selben Tag ist No-op', async () => {
    const { client, accounts } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    await runDailyInterestForServer(client, N1);
    const r2 = await runDailyInterestForServer(client, N1);
    expect(r2.skipped).toBe(true);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
  });

  it('darf denselben Tag fuer einen zweiten Gameserver separat verbuchen', async () => {
    const { client, accounts, runs, ledgerKeys } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
      { guildId: 'g', nitradoConnId: 'n2', userDiscordId: 'u1', bankBalance: 2000n },
    ]);

    const first = await runDailyInterestForServer(client, N1);
    const second = await runDailyInterestForServer(client, N2);

    expect(first.total).toBe(50n);
    expect(second.total).toBe(100n);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(accounts.get('g:n2:u1')!.bankBalance).toBe(2100n);
    expect(runs).toEqual(new Set(['g:n1:2026-08-01', 'g:n2:2026-08-01']));
    expect(ledgerKeys).toEqual(new Set([
      'interest:g:n1:2026-08-01:u1',
      'interest:g:n2:2026-08-01:u1',
    ]));
  });

  it('percent<=0 -> skipped', async () => {
    const { client } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    const r = await runDailyInterestForServer(client, { ...N1, percent: 0 });
    expect(r.skipped).toBe(true);
  });
});
