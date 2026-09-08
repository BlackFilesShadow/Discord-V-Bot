jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  },
}));

import prisma from '../../src/database/prisma';
import { POSTGRES_BIGINT_MAX } from '../../src/modules/economy/ledger';
import { runDailyTreasuryInterestForServer } from '../../src/modules/economy/virtualAccountInterest';

interface TreasuryRow {
  accountId: string;
  bankBalance: bigint;
}

interface PrismaInterestMock {
  $queryRawUnsafe: jest.Mock;
  $transaction: jest.Mock;
}

describe('runDailyTreasuryInterestForServer — BIGINT saturation isolation', () => {
  it('ueberspringt eine volle Serverbank und verzinst die naechste weiter', async () => {
    const prismaMock = prisma as unknown as PrismaInterestMock;
    const rows: TreasuryRow[] = [
      { accountId: 'treasury-saturated', bankBalance: POSTGRES_BIGINT_MAX },
      { accountId: 'treasury-normal', bankBalance: 1000n },
    ];
    prismaMock.$queryRawUnsafe.mockResolvedValue(rows);

    const txQuery = jest.fn(async (_query: string, ...values: unknown[]) => {
      const accountId = String(values[0]);
      const row = rows.find(candidate => candidate.accountId === accountId);
      return row ? [row] : [];
    });
    const txExecute = jest.fn(async () => 1);
    const tx = {
      $queryRawUnsafe: txQuery,
      $executeRawUnsafe: txExecute,
    };
    prismaMock.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));

    const result = await runDailyTreasuryInterestForServer({
      guildId: 'g',
      nitradoConnId: 'n1',
      runDate: '2026-09-08',
      basisPoints: 500,
    });

    expect(result).toEqual({ credited: 1, total: 50n });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    expect(txExecute).toHaveBeenCalledTimes(2);
    for (const call of txExecute.mock.calls) {
      expect(call).not.toContain('treasury-saturated');
      expect(call).toContain('treasury-normal');
    }
  });
});
