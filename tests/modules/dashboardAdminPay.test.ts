interface AccountState {
  walletBalance: bigint;
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

const ledgerRows = new Map<string, Record<string, unknown>>();
const accounts = new Map<string, AccountState>();
let transactionCount = 0;
const mockAssertEconomyScopeReady = jest.fn();

function accountKey(guildId: string, nitradoConnId: string, userDiscordId: string): string {
  return `${guildId}:${nitradoConnId}:${userDiscordId}`;
}

const txMock = {
  economyLedgerEntry: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const key = String(data.idempotencyKey);
      if (ledgerRows.has(key)) {
        const error = new Error('unique') as Error & { code?: string };
        error.code = 'P2002';
        throw error;
      }
      ledgerRows.set(key, { ...data });
      return { id: `ledger-${ledgerRows.size}` };
    }),
  },
  economyAccount: {
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const key = accountKey(String(where.guildId), String(where.nitradoConnId), String(where.userDiscordId));
      const account = accounts.get(key);
      const amount = (where.walletBalance as { gte: bigint }).gte;
      if (!account || account.walletBalance < amount) return { count: 0 };
      account.walletBalance -= (data.walletBalance as { decrement: bigint }).decrement;
      account.lifetimeSpent += (data.lifetimeSpent as { increment: bigint }).increment;
      return { count: 1 };
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const scope = where.guildServerUser as { guildId: string; nitradoConnId: string; userDiscordId: string };
      const key = accountKey(scope.guildId, scope.nitradoConnId, scope.userDiscordId);
      const current = accounts.get(key);
      if (!current) {
        accounts.set(key, {
          walletBalance: create.walletBalance as bigint,
          lifetimeEarned: create.lifetimeEarned as bigint,
          lifetimeSpent: create.lifetimeSpent as bigint,
        });
      } else {
        current.walletBalance += (update.walletBalance as { increment: bigint }).increment;
        current.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
      }
      return accounts.get(key);
    }),
  },
  economyTransaction: {
    create: jest.fn(async () => {
      transactionCount += 1;
      return { id: `tx-${transactionCount}` };
    }),
  },
};

const prismaMock = {
  $transaction: jest.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => {
    const ledgerSnapshot = new Map(ledgerRows);
    const accountSnapshot = new Map(Array.from(accounts, ([key, value]) => [key, { ...value }]));
    const txSnapshot = transactionCount;
    try {
      return await fn(txMock);
    } catch (error) {
      ledgerRows.clear();
      ledgerSnapshot.forEach((value, key) => ledgerRows.set(key, value));
      accounts.clear();
      accountSnapshot.forEach((value, key) => accounts.set(key, value));
      transactionCount = txSnapshot;
      throw error;
    }
  }),
  economyLedgerEntry: {
    findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => ledgerRows.get(where.idempotencyKey) ?? null),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: (...args: unknown[]) => mockAssertEconomyScopeReady(...args),
}));

import {
  applyDashboardAdminPay,
  type DashboardAdminPayInput,
} from '../../src/modules/economy/dashboardAdminPay';

const base: Omit<DashboardAdminPayInput, 'delta'> = {
  httpIdempotencyKey: 'retry-stable-http-key-001',
  guildId: '123456789012345678' as DashboardAdminPayInput['guildId'],
  nitradoConnId: 'c123456789012345678901234' as DashboardAdminPayInput['nitradoConnId'],
  targetUserId: '323456789012345678' as DashboardAdminPayInput['targetUserId'],
  reason: 'Dashboard-Korrektur',
  actorDiscordId: '223456789012345678' as DashboardAdminPayInput['actorDiscordId'],
};
const targetKey = accountKey(base.guildId, base.nitradoConnId, base.targetUserId);

describe('dashboard admin-pay domain idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ledgerRows.clear();
    accounts.clear();
    transactionCount = 0;
    mockAssertEconomyScopeReady.mockResolvedValue(undefined);
  });

  it('deducts exactly once when the HTTP layer re-runs the handler after a lost response', async () => {
    accounts.set(targetKey, { walletBalance: 1000n, lifetimeEarned: 1000n, lifetimeSpent: 0n });

    const first = await applyDashboardAdminPay({ ...base, delta: -250n });
    const reclaimedRetry = await applyDashboardAdminPay({ ...base, delta: -250n });

    expect(first).toEqual({ applied: true });
    expect(reclaimedRetry).toEqual({ applied: false });
    expect(accounts.get(targetKey)?.walletBalance).toBe(750n);
    expect(accounts.get(targetKey)?.lifetimeSpent).toBe(250n);
    expect(transactionCount).toBe(1);
    expect(ledgerRows.size).toBe(1);
    expect(mockAssertEconomyScopeReady).toHaveBeenCalledTimes(2);
  });

  it('credits a missing account exactly once', async () => {
    const first = await applyDashboardAdminPay({ ...base, delta: 500n });
    const retry = await applyDashboardAdminPay({ ...base, delta: 500n });

    expect(first.applied).toBe(true);
    expect(retry.applied).toBe(false);
    expect(accounts.get(targetKey)).toEqual({ walletBalance: 500n, lifetimeEarned: 500n, lifetimeSpent: 0n });
    expect(transactionCount).toBe(1);
  });

  it('rejects reuse of the same HTTP operation key with changed booking data', async () => {
    await applyDashboardAdminPay({ ...base, delta: 100n });

    await expect(applyDashboardAdminPay({ ...base, delta: 200n }))
      .rejects.toThrow('anderen Buchungsdaten');

    expect(accounts.get(targetKey)?.walletBalance).toBe(100n);
    expect(transactionCount).toBe(1);
  });

  it('rolls back the domain ledger claim when a negative booking is underfunded', async () => {
    accounts.set(targetKey, { walletBalance: 50n, lifetimeEarned: 50n, lifetimeSpent: 0n });

    await expect(applyDashboardAdminPay({ ...base, delta: -100n })).rejects.toThrow('zu wenig Guthaben');

    expect(accounts.get(targetKey)?.walletBalance).toBe(50n);
    expect(ledgerRows.size).toBe(0);
    expect(transactionCount).toBe(0);
  });

  it('preserves the legacy economy migration fail-closed guard before any money-domain mutation', async () => {
    mockAssertEconomyScopeReady.mockRejectedValueOnce(new Error('Legacy-Economy-Migration erforderlich'));

    await expect(applyDashboardAdminPay({ ...base, delta: 100n }))
      .rejects.toThrow('Legacy-Economy-Migration erforderlich');

    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(base.guildId, base.nitradoConnId);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(ledgerRows.size).toBe(0);
    expect(accounts.size).toBe(0);
    expect(transactionCount).toBe(0);
  });

  it('stores only a hashed derivative of the raw HTTP idempotency key', async () => {
    await applyDashboardAdminPay({ ...base, delta: 1n });

    const [[ledgerKey, row]] = Array.from(ledgerRows.entries());
    expect(ledgerKey).toMatch(/^dashboard-admin-pay:[a-f0-9]{64}$/);
    expect(ledgerKey).not.toContain(base.httpIdempotencyKey);
    expect(String(row.sourceRef)).toMatch(/^dashboard-admin-pay:[a-f0-9]{32}$/);
    expect(String(row.sourceRef)).not.toContain(base.httpIdempotencyKey);
  });

  it('rejects missing/short operation keys before opening a transaction', async () => {
    await expect(applyDashboardAdminPay({ ...base, httpIdempotencyKey: 'short', delta: 1n }))
      .rejects.toThrow('8..128');
    expect(mockAssertEconomyScopeReady).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
