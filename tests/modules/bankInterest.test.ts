/**
 * Economy / server-scope regression: Bank-Zinsen sind pro Gameserver
 * tagesidempotent, vollstaendig paginiert und duerfen denselben Discord-User in
 * einer Guild nicht serveruebergreifend vermischen.
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
interface InterestFixture {
  id?: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  bankBalance: bigint;
  createdAt?: Date;
}
interface ScopedInterestAccountRow extends InterestAccountRow { guildId: string; nitradoConnId: string }

function makeClient(accountsInit: InterestFixture[]) {
  const ledgerKeys = new Set<string>();
  const runs = new Set<string>();
  const accounts = new Map<string, Account>();
  const rows: ScopedInterestAccountRow[] = accountsInit.map((account, index) => ({
    id: account.id ?? `acct-${String(index + 1).padStart(4, '0')}`,
    guildId: account.guildId,
    nitradoConnId: account.nitradoConnId,
    userDiscordId: account.userDiscordId,
    bankBalance: account.bankBalance,
    createdAt: account.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  }));
  for (const account of rows) {
    accounts.set(`${account.guildId}:${account.nitradoConnId}:${account.userDiscordId}`, {
      walletBalance: 0n,
      bankBalance: account.bankBalance,
      lifetimeEarned: 0n,
      lifetimeSpent: 0n,
    });
  }

  const findMany = jest.fn(async (args: unknown): Promise<InterestAccountRow[]> => {
    const query = args as {
      where: {
        guildId: string;
        nitradoConnId: string;
        bankBalance: { gt: number };
        OR?: Array<
          | { createdAt: { gt: Date } }
          | { createdAt: Date; id: { gt: string } }
        >;
      };
      take: number;
    };
    const cursorParts = query.where.OR;
    return rows
      .filter(account => account.guildId === query.where.guildId
        && account.nitradoConnId === query.where.nitradoConnId
        && account.bankBalance > 0n)
      .filter(account => {
        if (!cursorParts) return true;
        const createdAfter = cursorParts[0] as { createdAt: { gt: Date } };
        const sameDateAfterId = cursorParts[1] as { createdAt: Date; id: { gt: string } };
        return account.createdAt.getTime() > createdAfter.createdAt.gt.getTime()
          || (account.createdAt.getTime() === sameDateAfterId.createdAt.getTime()
            && account.id > sameDateAfterId.id.gt);
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, query.take)
      .map(({ id, userDiscordId, bankBalance, createdAt }) => ({ id, userDiscordId, bankBalance, createdAt }));
  });

  const runCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    runs.add(`${String(data.guildId)}:${String(data.nitradoConnId)}:${String(data.runDate)}`);
    return {};
  });

  const client: BankInterestClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) {
              const error = new Error('unique') as Error & { code: string };
              error.code = 'P2002';
              throw error;
            }
            ledgerKeys.add(key);
            return { id: 'l-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const scoped = where.guildServerUser as { guildId: string; nitradoConnId: string; userDiscordId: string };
            const key = `${scoped.guildId}:${scoped.nitradoConnId}:${scoped.userDiscordId}`;
            if (!accounts.has(key)) {
              accounts.set(key, {
                walletBalance: create.walletBalance as bigint,
                bankBalance: create.bankBalance as bigint,
                lifetimeEarned: create.lifetimeEarned as bigint,
                lifetimeSpent: create.lifetimeSpent as bigint,
              });
            } else {
              const account = accounts.get(key)!;
              account.walletBalance += (update.walletBalance as { increment: bigint }).increment;
              account.bankBalance += (update.bankBalance as { increment: bigint }).increment;
              account.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
              account.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
            }
            return accounts.get(key);
          },
        },
      };
      return fn(tx);
    },
    bankInterestRun: {
      findUnique: async (args: unknown) => {
        const where = (args as { where: { guildServerRunDate: { guildId: string; nitradoConnId: string; runDate: string } } }).where.guildServerRunDate;
        const key = `${where.guildId}:${where.nitradoConnId}:${where.runDate}`;
        return runs.has(key) ? { id: key } : null;
      },
      create: runCreate,
    },
    economyAccount: {
      findMany,
      upsert: async () => ({}),
    },
  };
  return { client, accounts, runs, ledgerKeys, findMany, runCreate };
}

const N1 = { guildId: 'g', nitradoConnId: 'n1', percent: 5, runDate: '2026-08-01' };
const N2 = { guildId: 'g', nitradoConnId: 'n2', percent: 5, runDate: '2026-08-01' };

describe('runDailyInterestForServer — Pagination, Tagesidempotenz und Scope', () => {
  it('schreibt Zinsen nur auf den ausgewaehlten Server-Account gut', async () => {
    const { client, accounts } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
      { guildId: 'g', nitradoConnId: 'n2', userDiscordId: 'u1', bankBalance: 2000n },
    ]);
    const result = await runDailyInterestForServer(client, N1);
    expect(result.credited).toBe(1);
    expect(result.total).toBe(50n);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(accounts.get('g:n2:u1')!.bankBalance).toBe(2000n);
  });

  it('paginiert ueber alle positiven Konten statt nach der ersten Seite den Tag abzuschliessen', async () => {
    const sameCreatedAt = new Date('2026-08-01T00:00:00.000Z');
    const { client, accounts, findMany, runs } = makeClient([
      { id: 'acct-a', guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 100n, createdAt: sameCreatedAt },
      { id: 'acct-b', guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u2', bankBalance: 200n, createdAt: sameCreatedAt },
      { id: 'acct-c', guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u3', bankBalance: 300n, createdAt: sameCreatedAt },
      { id: 'acct-d', guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u4', bankBalance: 400n, createdAt: new Date('2026-08-01T00:00:01.000Z') },
      { id: 'acct-e', guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u5', bankBalance: 500n, createdAt: new Date('2026-08-01T00:00:02.000Z') },
    ]);

    const result = await runDailyInterestForServer(client, { ...N1, percent: 10, limit: 2 });

    expect(result).toMatchObject({ credited: 5, total: 150n, skipped: false });
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(110n);
    expect(accounts.get('g:n1:u2')!.bankBalance).toBe(220n);
    expect(accounts.get('g:n1:u3')!.bankBalance).toBe(330n);
    expect(accounts.get('g:n1:u4')!.bankBalance).toBe(440n);
    expect(accounts.get('g:n1:u5')!.bankBalance).toBe(550n);
    expect(runs).toContain('g:n1:2026-08-01');

    const secondPage = findMany.mock.calls[1][0] as { where: { OR: unknown[] }; take: number };
    expect(secondPage.take).toBe(2);
    expect(secondPage.where.OR).toEqual([
      { createdAt: { gt: sameCreatedAt } },
      { createdAt: sameCreatedAt, id: { gt: 'acct-b' } },
    ]);
  });

  it('zweiter Lauf desselben Servers am selben Tag ist No-op', async () => {
    const { client, accounts, findMany } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    await runDailyInterestForServer(client, N1);
    const result = await runDailyInterestForServer(client, N1);
    expect(result.skipped).toBe(true);
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('darf denselben Tag fuer einen zweiten Gameserver separat verbuchen und speichert keine rohe Discord-ID im Ledger-Key', async () => {
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
    expect(ledgerKeys.size).toBe(2);
    for (const key of ledgerKeys) {
      expect(key).toMatch(/^interest:g:n[12]:2026-08-01:es1_[a-f0-9]{32}$/);
      expect(key).not.toContain(':u1');
    }
  });

  it('meldet einen echten Tagesmarker-DB-Fehler und kann danach idempotent wiederholen', async () => {
    const { client, accounts, runCreate, ledgerKeys, runs } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    runCreate.mockRejectedValueOnce(new Error('marker database unavailable'));

    await expect(runDailyInterestForServer(client, N1)).rejects.toThrow('marker database unavailable');
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(ledgerKeys.size).toBe(1);
    expect(runs).not.toContain('g:n1:2026-08-01');

    const retry = await runDailyInterestForServer(client, N1);
    expect(retry).toEqual({ credited: 0, total: 0n, skipped: false });
    expect(accounts.get('g:n1:u1')!.bankBalance).toBe(1050n);
    expect(ledgerKeys.size).toBe(1);
    expect(runs).toContain('g:n1:2026-08-01');
  });

  it('toleriert nur die erwartete Unique-Kollision beim Tagesmarker eines Parallel-Laufs', async () => {
    const { client, runCreate } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    const unique = Object.assign(new Error('parallel marker'), { code: 'P2002' });
    runCreate.mockRejectedValueOnce(unique);

    await expect(runDailyInterestForServer(client, N1)).resolves.toMatchObject({ credited: 1, total: 50n, skipped: false });
  });

  it('percent<=0 -> skipped ohne Konten zu lesen', async () => {
    const { client, findMany } = makeClient([
      { guildId: 'g', nitradoConnId: 'n1', userDiscordId: 'u1', bankBalance: 1000n },
    ]);
    const result = await runDailyInterestForServer(client, { ...N1, percent: 0 });
    expect(result.skipped).toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });
});
