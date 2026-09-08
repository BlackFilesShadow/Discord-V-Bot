import {
  runDailyInterestForServer,
  type BankInterestClient,
  type InterestAccountRow,
} from '../../src/modules/economy/bankInterest';
import {
  POSTGRES_BIGINT_MAX,
  type LedgerTx,
} from '../../src/modules/economy/ledger';

interface AccountState {
  walletBalance: bigint;
  bankBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

const GUILD_ID = 'g';
const NITRADO_CONN_ID = 'n1';
const RUN_DATE = '2026-09-08';

function scopedKey(userDiscordId: string): string {
  return `${GUILD_ID}:${NITRADO_CONN_ID}:${userDiscordId}`;
}

function makeClient(rows: InterestAccountRow[]) {
  const accounts = new Map<string, AccountState>();
  for (const row of rows) {
    accounts.set(scopedKey(row.userDiscordId), {
      walletBalance: 0n,
      bankBalance: row.bankBalance,
      lifetimeEarned: 0n,
      lifetimeSpent: 0n,
    });
  }

  const ledgerKeys = new Set<string>();
  const markerCreate = jest.fn(async () => ({}));
  const client: BankInterestClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        $queryRawUnsafe: async <TResult = unknown>(
          query: string,
          ...values: unknown[]
        ): Promise<TResult> => {
          if (query.includes('FROM "EconomyAccount"')) {
            const key = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
            const account = accounts.get(key);
            return (account ? [account] : []) as TResult;
          }
          return [] as TResult;
        },
        $executeRawUnsafe: async () => 0,
        economyLedgerEntry: {
          create: async ({ data }) => {
            const idempotencyKey = String(data.idempotencyKey);
            if (ledgerKeys.has(idempotencyKey)) {
              throw Object.assign(new Error('unique'), { code: 'P2002' });
            }
            ledgerKeys.add(idempotencyKey);
            return { id: `ledger-${ledgerKeys.size}` };
          },
          findUnique: async ({ where }) => ledgerKeys.has(where.idempotencyKey)
            ? { id: 'existing-ledger' }
            : null,
        },
        economyAccount: {
          upsert: async ({ where, update }) => {
            const scope = where.guildServerUser as {
              guildId: string;
              nitradoConnId: string;
              userDiscordId: string;
            };
            const account = accounts.get(`${scope.guildId}:${scope.nitradoConnId}:${scope.userDiscordId}`);
            if (!account) throw new Error('fixture account missing');
            account.walletBalance += (update.walletBalance as { increment: bigint }).increment;
            account.bankBalance += (update.bankBalance as { increment: bigint }).increment;
            account.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
            account.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
            return account;
          },
        },
      };
      return fn(tx);
    },
    bankInterestRun: {
      findUnique: async () => null,
      create: markerCreate,
    },
    economyAccount: {
      findMany: async () => rows,
      upsert: async () => ({}),
    },
  };

  return { client, accounts, ledgerKeys, markerCreate };
}

describe('runDailyInterestForServer — BIGINT saturation isolation', () => {
  it('ueberspringt nur das ausgeschoepfte Konto und verzinst nachfolgende Konten weiter', async () => {
    const rows: InterestAccountRow[] = [
      {
        id: 'acct-saturated',
        userDiscordId: 'u-saturated',
        bankBalance: POSTGRES_BIGINT_MAX,
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      {
        id: 'acct-normal',
        userDiscordId: 'u-normal',
        bankBalance: 1000n,
        createdAt: new Date('2026-09-08T00:00:01.000Z'),
      },
    ];
    const { client, accounts, ledgerKeys, markerCreate } = makeClient(rows);

    const result = await runDailyInterestForServer(client, {
      guildId: GUILD_ID,
      nitradoConnId: NITRADO_CONN_ID,
      runDate: RUN_DATE,
      percent: 5,
    });

    expect(result).toEqual({ credited: 1, total: 50n, skipped: false });
    expect(accounts.get(scopedKey('u-saturated'))!.bankBalance).toBe(POSTGRES_BIGINT_MAX);
    expect(accounts.get(scopedKey('u-normal'))!.bankBalance).toBe(1050n);
    expect(ledgerKeys.size).toBe(1);
    expect(markerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: GUILD_ID,
        nitradoConnId: NITRADO_CONN_ID,
        runDate: RUN_DATE,
        accountsCredited: 1,
        totalCredited: 50n,
      }),
    });
  });

  it('begrenzt die Tagesgesamtsumme bevor der BIGINT-Marker unrepresentierbar wird', async () => {
    const half = POSTGRES_BIGINT_MAX / 2n;
    const rows: InterestAccountRow[] = [
      {
        id: 'acct-a',
        userDiscordId: 'u-a',
        bankBalance: half,
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
      },
      {
        id: 'acct-b',
        userDiscordId: 'u-b',
        bankBalance: half,
        createdAt: new Date('2026-09-08T00:00:01.000Z'),
      },
      {
        id: 'acct-c',
        userDiscordId: 'u-c',
        bankBalance: half,
        createdAt: new Date('2026-09-08T00:00:02.000Z'),
      },
    ];
    const { client, accounts, ledgerKeys, markerCreate } = makeClient(rows);

    const result = await runDailyInterestForServer(client, {
      guildId: GUILD_ID,
      nitradoConnId: NITRADO_CONN_ID,
      runDate: RUN_DATE,
      basisPoints: 10_000,
    });

    expect(result).toEqual({ credited: 2, total: POSTGRES_BIGINT_MAX - 1n, skipped: false });
    expect(accounts.get(scopedKey('u-a'))!.bankBalance).toBe(POSTGRES_BIGINT_MAX - 1n);
    expect(accounts.get(scopedKey('u-b'))!.bankBalance).toBe(POSTGRES_BIGINT_MAX - 1n);
    expect(accounts.get(scopedKey('u-c'))!.bankBalance).toBe(half);
    expect(ledgerKeys.size).toBe(2);
    expect(markerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountsCredited: 2,
        totalCredited: POSTGRES_BIGINT_MAX - 1n,
      }),
    });
  });
});
