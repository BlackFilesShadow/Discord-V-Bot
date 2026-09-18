process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const GUILD = '999999999999999999';
const CONN = 'c123456789012345678901234';
const ACTOR = '888888888888888888';

const txMock = {
  nitradoConnection: {
    findFirst: jest.fn(),
  },
  nitradoRestartPlan: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  nitradoJob: {
    updateMany: jest.fn(),
    create: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
  nitradoRestartPlan: {
    updateMany: jest.fn(),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

import {
  RestartPlanBindingConflictError,
  RESTART_PLAN_SYNC_OPERATION,
  clearRestartPlan,
  saveRestartPlan,
} from '../../src/modules/nitrado/restartTaskPlanStore';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const scope = {
  guildId: asGuildId(GUILD),
  nitradoConnId: asNitradoConnId(CONN),
  nitradoServerId: '12345',
};
const actor = asUserDiscordId(ACTOR);

beforeEach(() => {
  jest.clearAllMocks();
  txMock.nitradoConnection.findFirst.mockResolvedValue({ id: CONN });
  txMock.nitradoRestartPlan.findUnique.mockResolvedValue(null);
  txMock.nitradoRestartPlan.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
  txMock.nitradoJob.updateMany.mockResolvedValue({ count: 0 });
  txMock.nitradoJob.create.mockResolvedValue({ id: 'job-1' });
});

describe('Nitrado restart plan persistence', () => {
  it('revalidates the exact active service binding inside the serializable transaction', async () => {
    await saveRestartPlan(scope, actor, {
      mode: 'INTERVAL',
      intervalHours: 4,
      startTime: '00:00',
      times: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
    });

    expect(txMock.nitradoConnection.findFirst).toHaveBeenCalledWith({
      where: {
        id: CONN,
        guildId: GUILD,
        status: 'ACTIVE',
        nitradoServerId: '12345',
      },
      select: { id: true },
    });
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('fails closed and writes neither plan nor job if the service binding changed', async () => {
    txMock.nitradoConnection.findFirst.mockResolvedValue(null);

    await expect(saveRestartPlan(scope, actor, {
      mode: 'INTERVAL',
      intervalHours: 4,
      startTime: '00:00',
      times: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
    })).rejects.toBeInstanceOf(RestartPlanBindingConflictError);

    expect(txMock.nitradoRestartPlan.upsert).not.toHaveBeenCalled();
    expect(txMock.nitradoJob.create).not.toHaveBeenCalled();
  });

  it('increments the plan revision, supersedes only pending plan-sync jobs and enqueues the new revision', async () => {
    txMock.nitradoRestartPlan.findUnique.mockResolvedValue({ revision: 7 });
    txMock.nitradoRestartPlan.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => update);

    const saved = await saveRestartPlan(scope, actor, {
      mode: 'FIXED',
      intervalHours: null,
      startTime: null,
      times: ['01:00', '13:00'],
    });

    expect(saved).toEqual(expect.objectContaining({
      revision: 8,
      syncStatus: 'PENDING',
      nitradoServerId: '12345',
      times: ['01:00', '13:00'],
    }));
    expect(txMock.nitradoJob.updateMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        nitradoConnId: CONN,
        operation: RESTART_PLAN_SYNC_OPERATION,
        status: 'PENDING',
      },
      data: expect.objectContaining({ status: 'DONE' }),
    });
    expect(txMock.nitradoJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: GUILD,
        nitradoConnId: CONN,
        operation: RESTART_PLAN_SYNC_OPERATION,
        payload: { planRevision: 8 },
        status: 'PENDING',
        maxAttempts: 8,
      }),
    });
  });

  it('queues an empty desired state when all restart tasks are cleared', async () => {
    txMock.nitradoRestartPlan.findUnique.mockResolvedValue({
      revision: 2,
      mode: 'INTERVAL',
      intervalHours: 4,
      startTime: '00:00',
    });
    txMock.nitradoRestartPlan.upsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => update);

    const saved = await clearRestartPlan(scope, actor);

    expect(saved).toEqual(expect.objectContaining({
      enabled: false,
      times: [],
      revision: 3,
      syncStatus: 'PENDING',
    }));
    expect(txMock.nitradoJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: RESTART_PLAN_SYNC_OPERATION,
        payload: { planRevision: 3 },
      }),
    });
  });
});
