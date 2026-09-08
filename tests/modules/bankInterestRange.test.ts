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

function scopedKey(guildId: string, nitradoConnId: string, userDiscordId: string): string {
  return `${guildId}:${nitradoConnId}:${userDiscordId}`;
}

describe('runDailyInterestForServer — BIGINT saturation isolation', () => {
  it('ueberspringt nur das ausgeschoepfte Konto und verzinst nachfolgende Konten weiter', async () => {
    const guildId = 'g';
    const nitradoConnId = 'n1';
    const runDate = '2026-09-08';
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
    const accounts = new Map<string, AccountState>([
      [scopedKey(guildId, nitradoConnId, 'u-saturated'), {
        walletBalance: 0n,
        bankBalance: POSTGRES_BIGINT_MAX,
        lifetimeEarned: 0n,
        lifetimeSpent: 0n,
      }],
      [scopedKey(guildId, nitradoConnId, 'u-normal'), {
        walletBalance: 0n,
        bankBalance: 1000n,
        lifetimeEarned: 0n,
        lifetimeSpent: 0n,
      }],
    ]);
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
              const key = scopedKey(String(values[0]), String(values[1]), String(values[2]));
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
              const account = accounts.get(scopedKey(scope.guildId, scope.nitradoConnId, scope.userDiscordId));
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

    const result = await runDailyInterestForServer(client, {
      guildId,
      nitradoConnId,
      runDate,
      percent: 5,
    });

    expect(result).toEqual({ credited: 1, total: 50n, skipped: false });
    expect(accounts.get(scopedKey(guildId, nitradoConnId, 'u-saturated'))!.bankBalance)
      .toBe(POSTGRES_BIGINT_MAX);
    expect(accounts.get(scopedKey(guildId, nitradoConnId, 'u-normal'))!.bankBalance).toBe(1050n);
    expect(ledgerKeys).toHaveSize(1);
    expect(markerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId,
        nitradoConnId,
        runDate,
        accountsCredited: 1,
        totalCredited: 50n,
      }),
    });
  });
});
