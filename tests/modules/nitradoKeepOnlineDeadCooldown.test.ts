process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const slotFindManyMock = jest.fn();
const jobFindFirstMock = jest.fn();
const jobCreateMock = jest.fn();
const txClient = {
  nitradoJob: {
    findFirst: jobFindFirstMock,
    create: jobCreateMock,
  },
};
const transactionMock = jest.fn(async (
  callback: (tx: typeof txClient) => Promise<unknown>,
) => callback(txClient));

const prismaMock = {
  nitradoConnection: { findMany: slotFindManyMock },
  $transaction: transactionMock,
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { Prisma } from '@prisma/client';
import {
  KEEP_ONLINE_DEAD_RETRY_COOLDOWN_MS,
  runKeepOnlinePollOnce,
} from '../../src/modules/nitrado/permaOnlyCron';
import { KEEP_ONLINE_DISABLED_JOB_REASON } from '../../src/modules/nitrado/keepOnlineJobs';

const NOW = new Date('2026-08-18T14:30:00.000Z');

interface BlockerQuery {
  where: {
    guildId: string;
    nitradoConnId: string;
    operation: string;
    OR: Array<Record<string, unknown>>;
  };
}

function firstBlockerQuery(): BlockerQuery {
  const calls = jobFindFirstMock.mock.calls as unknown as Array<[BlockerQuery]>;
  return calls[0][0];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  slotFindManyMock.mockResolvedValue([{ id: 'conn-1', guildId: 'guild-1' }]);
  jobFindFirstMock.mockResolvedValue(null);
  jobCreateMock.mockResolvedValue({ id: 'job-new' });
  transactionMock.mockImplementation(async (
    callback: (tx: typeof txClient) => Promise<unknown>,
  ) => callback(txClient));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Nitrado-1H — Keep-Online DEAD retry cooldown', () => {
  it('blockiert einen neuen Auto-Start, solange ein echter DEAD-Fehler noch im Cooldown liegt', async () => {
    jobFindFirstMock.mockResolvedValue({ id: 'dead-recent' });

    await runKeepOnlinePollOnce();

    expect(jobCreateMock).not.toHaveBeenCalled();
    expect(jobFindFirstMock).toHaveBeenCalledTimes(1);

    const call = firstBlockerQuery();
    const expectedCutoff = new Date(NOW.getTime() - KEEP_ONLINE_DEAD_RETRY_COOLDOWN_MS);

    expect(call.where).toEqual({
      guildId: 'guild-1',
      nitradoConnId: 'conn-1',
      operation: 'RESTART_IF_DOWN',
      OR: [
        { status: { in: ['PENDING', 'RUNNING'] } },
        {
          status: 'DEAD',
          updatedAt: { gte: expectedCutoff },
          OR: [
            { lastError: null },
            { lastError: { not: KEEP_ONLINE_DISABLED_JOB_REASON } },
          ],
        },
      ],
    });
  });

  it('nimmt ausschliesslich bewusst beim Deaktivieren verworfene DEAD-Jobs vom Failure-Cooldown aus', async () => {
    await runKeepOnlinePollOnce();

    expect(firstBlockerQuery().where.OR[1]).toEqual({
      status: 'DEAD',
      updatedAt: { gte: new Date(NOW.getTime() - KEEP_ONLINE_DEAD_RETRY_COOLDOWN_MS) },
      OR: [
        { lastError: null },
        { lastError: { not: KEEP_ONLINE_DISABLED_JOB_REASON } },
      ],
    });
  });

  it('erzeugt nach freiem Cooldown genau einen neuen begrenzten Auto-Start-Job', async () => {
    await runKeepOnlinePollOnce();

    expect(transactionMock).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    expect(jobCreateMock).toHaveBeenCalledTimes(1);
    expect(jobCreateMock).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-1',
        nitradoConnId: 'conn-1',
        operation: 'RESTART_IF_DOWN',
        payload: {},
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: NOW,
      },
    });
  });
});
