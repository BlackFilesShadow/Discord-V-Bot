const ledgerKeys = new Set<string>();
let walletBalance = 1000n;
let lifetimeSpent = 0n;
let transactionCount = 0;

const txMock = {
  economyLedgerEntry: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const key = String(data.idempotencyKey);
      if (ledgerKeys.has(key)) {
        const error = new Error('unique') as Error & { code?: string };
        error.code = 'P2002';
        throw error;
      }
      ledgerKeys.add(key);
      return { id: 'ledger-1' };
    }),
  },
  economyAccount: {
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const amount = ((where.walletBalance as { gte: bigint }).gte);
      if (walletBalance < amount) return { count: 0 };
      const decrement = ((data.walletBalance as { decrement: bigint }).decrement);
      const spent = ((data.lifetimeSpent as { increment: bigint }).increment);
      walletBalance -= decrement;
      lifetimeSpent += spent;
      return { count: 1 };
    }),
    upsert: jest.fn(async () => ({})),
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
    const snapshot = {
      ledgerKeys: new Set(ledgerKeys),
      walletBalance,
      lifetimeSpent,
      transactionCount,
    };
    try {
      return await fn(txMock);
    } catch (error) {
      ledgerKeys.clear();
      snapshot.ledgerKeys.forEach(key => ledgerKeys.add(key));
      walletBalance = snapshot.walletBalance;
      lifetimeSpent = snapshot.lifetimeSpent;
      transactionCount = snapshot.transactionCount;
      throw error;
    }
  }),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

import { applyPendingAdminMoneyAction } from '../../src/modules/economy/pendingAdminMoney';

const base = {
  actionId: '123e4567-e89b-42d3-a456-426614174000',
  guildId: '123456789012345678',
  nitradoConnId: 'c123456789012345678901234',
  targetUserId: '323456789012345678',
  reason: 'Korrektur',
  actorDiscordId: '223456789012345678',
};

describe('pending admin money exact-once booking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ledgerKeys.clear();
    walletBalance = 1000n;
    lifetimeSpent = 0n;
    transactionCount = 0;
  });

  it('deducts exactly once across a retry with the same pending action id', async () => {
    const first = await applyPendingAdminMoneyAction({ ...base, delta: -250n });
    const retry = await applyPendingAdminMoneyAction({ ...base, delta: -250n });

    expect(first).toEqual({ applied: true });
    expect(retry).toEqual({ applied: false });
    expect(walletBalance).toBe(750n);
    expect(lifetimeSpent).toBe(250n);
    expect(transactionCount).toBe(1);
    expect(ledgerKeys).toEqual(new Set([`pending-action:${base.actionId}:admin-pay`]));
  });

  it('rolls back the idempotency ledger claim when the deduction cannot be applied', async () => {
    walletBalance = 100n;

    await expect(applyPendingAdminMoneyAction({ ...base, delta: -250n }))
      .rejects.toThrow('zu wenig Guthaben');

    expect(walletBalance).toBe(100n);
    expect(lifetimeSpent).toBe(0n);
    expect(transactionCount).toBe(0);
    expect(ledgerKeys.size).toBe(0);
  });

  it('rejects zero deltas and malformed action ids before opening a transaction', async () => {
    await expect(applyPendingAdminMoneyAction({ ...base, delta: 0n })).rejects.toThrow('Delta');
    await expect(applyPendingAdminMoneyAction({ ...base, actionId: 'not-a-uuid', delta: -1n })).rejects.toThrow('Action-ID');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
