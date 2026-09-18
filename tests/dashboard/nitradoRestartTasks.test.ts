process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD = '999999999999999999';
const ACTOR = '888888888888888888';
const CONN = 'c123456789012345678901234';

const resolveDashboardGameServer = jest.fn();
const sendDashboardServerResolutionError = jest.fn();
const saveRestartPlan = jest.fn();
const clearRestartPlan = jest.fn();
const logAuditDb = jest.fn((..._args: unknown[]) => undefined);
const acquireMutationLock = jest.fn();
const releaseMutationLock = jest.fn(async () => undefined);
const decryptMock = jest.fn((..._args: unknown[]) => 'decrypted-token');

const listTasks = jest.fn();
const getTaskActionCatalog = jest.fn();

const MockNitradoApiError = class NitradoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly endpoint: string,
  ) {
    super(message);
  }
};
const MockBindingConflictError = class RestartPlanBindingConflictError extends Error {
  readonly code = 'NITRADO_TASK_BINDING_CHANGED';
};

const prismaMock = {
  nitradoConnection: {
    findFirst: jest.fn(),
  },
  nitradoRestartPlan: {
    findUnique: jest.fn(),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => decryptMock(...args),
}));
jest.mock('../../src/utils/logger', () => ({
  logAuditDb: (...args: unknown[]) => logAuditDb(...args),
}));
jest.mock('../../src/dashboard/routes/v2/serverScope', () => ({
  resolveDashboardGameServer: (...args: unknown[]) => resolveDashboardGameServer(...args),
  sendDashboardServerResolutionError: (...args: unknown[]) => sendDashboardServerResolutionError(...args),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireGuildPermission: (_permission: string) => (
    req: { auth?: unknown; guildScope?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = { userId: 'user-1', discordId: ACTOR, role: 'USER' };
    req.guildScope = {
      guildId: GUILD,
      actorDiscordId: ACTOR,
      nitradoConnId: null,
      isOwner: false,
      permissions: new Set(['nitrado.view', 'nitrado.write']),
    };
    next();
  },
}));
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoApiError: MockNitradoApiError,
  NitradoClient: jest.fn().mockImplementation(() => ({
    listTasks,
    getTaskActionCatalog,
  })),
}));
jest.mock('../../src/modules/nitrado/restartTaskPlanStore', () => ({
  saveRestartPlan: (...args: unknown[]) => saveRestartPlan(...args),
  clearRestartPlan: (...args: unknown[]) => clearRestartPlan(...args),
  parsePlanTimes: (value: unknown) =>
    Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [],
  RestartPlanBindingConflictError: MockBindingConflictError,
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => acquireMutationLock(...args),
}));

import express from 'express';
import request from 'supertest';
import { nitradoTasksRouter } from '../../src/dashboard/routes/v2/nitradoTasks';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/guilds/:guildId/nitrado-tasks', nitradoTasksRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveDashboardGameServer.mockResolvedValue({ kind: 'RESOLVED', nitradoConnId: CONN });
  prismaMock.nitradoConnection.findFirst.mockResolvedValue({ id: CONN, nitradoServerId: '12345', encryptedToken: 'enc' });
  prismaMock.nitradoRestartPlan.findUnique.mockResolvedValue(null);
  listTasks.mockResolvedValue([]);
  getTaskActionCatalog.mockResolvedValue([{ action_method: 'game_server_restart' }]);
  saveRestartPlan.mockResolvedValue({ revision: 1, syncStatus: 'PENDING' });
  clearRestartPlan.mockResolvedValue({ revision: 2, syncStatus: 'PENDING' });
  acquireMutationLock.mockResolvedValue({ release: releaseMutationLock });
  releaseMutationLock.mockResolvedValue(undefined);
});

describe('Nitrado restart task dashboard API', () => {
  it('reads the real Nitrado task list and reports exact remote synchronization', async () => {
    prismaMock.nitradoRestartPlan.findUnique.mockResolvedValue({ enabled: true, mode: 'INTERVAL', intervalHours: 4, startTime: '00:00', times: ['00:00', '04:00'], revision: 3, syncStatus: 'SYNCED', lastSyncAt: new Date('2026-09-18T00:00:00Z'), lastSyncError: null, nitradoServerId: '12345' });
    listTasks.mockResolvedValue([
      { id: 10, hour: '0', minute: '0', day: '*', month: '*', weekday: '*', action_method: 'game_server_restart', last_run: null, next_run: null, timezone: 'Europe/Berlin' },
      { id: 11, hour: '4', minute: '0', day: '*', month: '*', weekday: '*', action_method: 'game_server_restart', last_run: null, next_run: null, timezone: 'Europe/Berlin' },
      { id: 12, hour: '7', minute: '0', day: '*', month: '*', weekday: '*', action_method: 'game_server_stop', last_run: null, next_run: null, timezone: 'Europe/Berlin' },
    ]);
    const res = await request(app()).get(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`);
    expect(res.status).toBe(200);
    expect(res.body.remote.actionSupported).toBe(true);
    expect(res.body.remote.synchronized).toBe(true);
    expect(res.body.remote.restartTasks).toHaveLength(2);
    expect(res.body.remote.restartTasks.map((row: { time: string }) => row.time)).toEqual(['00:00', '04:00']);
    expect(listTasks).toHaveBeenCalledWith('12345');
    expect(getTaskActionCatalog).toHaveBeenCalledWith('12345');
  });

  it('rejects malformed restart plans before creating any durable work', async () => {
    const res = await request(app()).put(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`).send({ mode: 'INTERVAL', intervalHours: 5, startTime: '00:00' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NITRADO_RESTART_PLAN_INVALID');
    expect(saveRestartPlan).not.toHaveBeenCalled();
  });

  it('queues an exact canonical plan instead of mutating Nitrado in the HTTP request', async () => {
    const res = await request(app()).put(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`).send({ mode: 'INTERVAL', intervalHours: 4, startTime: '0:15' });
    expect(res.status).toBe(202);
    expect(res.body.times).toEqual(['00:15', '04:15', '08:15', '12:15', '16:15', '20:15']);
    expect(saveRestartPlan).toHaveBeenCalledWith({ guildId: GUILD, nitradoConnId: CONN, nitradoServerId: '12345' }, ACTOR, { mode: 'INTERVAL', intervalHours: 4, startTime: '00:15', times: ['00:15', '04:15', '08:15', '12:15', '16:15', '20:15'] });
    expect(listTasks).not.toHaveBeenCalled();
    expect(acquireMutationLock).toHaveBeenCalledWith(CONN);
    expect(releaseMutationLock).toHaveBeenCalledTimes(1);
  });

  it('fails busy with 409 before persisting a new desired state', async () => {
    acquireMutationLock.mockResolvedValue(null);
    const res = await request(app()).put(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`).send({ mode: 'FIXED', times: ['04:00'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_CONNECTION_BUSY');
    expect(saveRestartPlan).not.toHaveBeenCalled();
    expect(releaseMutationLock).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the mutation-lock infrastructure is unavailable', async () => {
    acquireMutationLock.mockRejectedValue(new Error('lock db down'));
    const res = await request(app()).put(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`).send({ mode: 'FIXED', times: ['04:00'] });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NITRADO_LOCK_UNAVAILABLE');
    expect(saveRestartPlan).not.toHaveBeenCalled();
  });

  it('maps a binding race to 409 instead of queueing a stale success response', async () => {
    saveRestartPlan.mockRejectedValue(new MockBindingConflictError('binding changed'));
    const res = await request(app()).put(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`).send({ mode: 'FIXED', times: ['04:00'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_TASK_BINDING_CHANGED');
    expect(logAuditDb).not.toHaveBeenCalled();
    expect(releaseMutationLock).toHaveBeenCalledTimes(1);
  });

  it('queues deletion of every restart task without deleting other task types in the route', async () => {
    const res = await request(app()).delete(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-tasks?slot=1`);
    expect(res.status).toBe(202);
    expect(clearRestartPlan).toHaveBeenCalledWith({ guildId: GUILD, nitradoConnId: CONN, nitradoServerId: '12345' }, ACTOR);
    expect(res.body).toEqual(expect.objectContaining({ enabled: false, times: [], syncStatus: 'PENDING' }));
    expect(listTasks).not.toHaveBeenCalled();
    expect(acquireMutationLock).toHaveBeenCalledWith(CONN);
    expect(releaseMutationLock).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmed remote tasks visible when only the action catalog is temporarily unavailable', async () => {
    listTasks.mockResolvedValue([{ id: 10, hour: '4', minute: '0', day: '*', month: '*', weekday: '*', action_method: 'game_server_restart', last_run: null, next_run: null, timezone: 'Europe/Berlin' }]);
    getTaskActionCatalog.mockRejectedValue(new MockNitradoApiError('catalog down', 503, '/tasks/list'));
    const res = await request(app()).get(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`);
    expect(res.status).toBe(200);
    expect(res.body.remote.actionSupported).toBeNull();
    expect(res.body.remote.restartTasks).toEqual([expect.objectContaining({ id: 10, time: '04:00' })]);
  });

  it('fails closed when Nitrado task reads are unavailable', async () => {
    listTasks.mockRejectedValue(new MockNitradoApiError('remote down', 503, '/tasks'));
    const res = await request(app()).get(`/api/v2/guilds/${GUILD}/nitrado-tasks/restart-plan?slot=1`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NITRADO_TASK_REMOTE_UNAVAILABLE');
    expect(res.body).not.toHaveProperty('remote');
  });
});
