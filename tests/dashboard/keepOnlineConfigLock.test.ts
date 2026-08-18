process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD = '999999999999999999';
const ACTOR = '888888888888888888';
const CONN = 'c123456789012345678901234';
const REPLACEMENT = 'c223456789012345678901234';

const resolveDashboardGameServer = jest.fn();
const sendDashboardServerResolutionError = jest.fn();
const tryAcquireNitradoConfigMutationLock = jest.fn();
const releaseLock = jest.fn().mockResolvedValue(undefined);
const cancelPendingKeepOnlineJobs = jest.fn().mockResolvedValue(1);
const logAuditDb = jest.fn();
const emitGuildEvent = jest.fn();

const settingsRow = {
  whitelistActive: true,
  economyActive: false,
  whitelistChannelId: null,
  whitelistRequestChannelId: null,
};

const txMock = {
  serverSettings: { upsert: jest.fn().mockResolvedValue(settingsRow) },
  economyConfig: { upsert: jest.fn().mockResolvedValue({}) },
  economySlotConfig: { upsert: jest.fn().mockResolvedValue({}) },
  nitradoConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

const prismaMock = {
  nitradoConnection: { findFirst: jest.fn() },
  serverSettings: { upsert: jest.fn().mockResolvedValue(settingsRow) },
  $transaction: jest.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/dashboard/repository', () => ({ getOrCreate: jest.fn() }));
jest.mock('../../src/modules/nitrado/repository', () => ({ listSlots: jest.fn() }));
jest.mock('../../src/modules/permissions/repository', () => ({ listGrants: jest.fn() }));
jest.mock('../../src/modules/nitrado/keepOnlineJobs', () => ({
  cancelPendingKeepOnlineJobs: (client: unknown, scopeArg: unknown) => cancelPendingKeepOnlineJobs(client, scopeArg),
}));
jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (nitradoConnId: string) => tryAcquireNitradoConfigMutationLock(nitradoConnId),
}));
jest.mock('../../src/dashboard/routes/v2/serverScope', () => ({
  resolveDashboardGameServer: (guildId: unknown, actorDiscordId: unknown, slotParam: unknown) =>
    resolveDashboardGameServer(guildId, actorDiscordId, slotParam),
  sendDashboardServerResolutionError: (res: unknown, resolution: unknown) =>
    sendDashboardServerResolutionError(res, resolution),
}));
jest.mock('../../src/utils/logger', () => ({
  logAuditDb: (action: unknown, category: unknown, options: unknown) => logAuditDb(action, category, options),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitGuildEvent: (guildId: unknown, event: unknown) => emitGuildEvent(guildId, event),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireGuildPermission: () => (req: { auth?: unknown; guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', discordId: ACTOR, role: 'USER' };
    req.guildScope = {
      guildId: GUILD,
      actorDiscordId: ACTOR,
      isOwner: false,
      permissions: new Set(['whitelist.view', 'whitelist.manage', 'economy.manage', 'nitrado.keep-online']),
    };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { dashboardRouter } from '../../src/dashboard/routes/v2/dashboard';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/guilds/:guildId/dashboard', dashboardRouter);
  return instance;
}

function resolved(id = CONN) {
  return { kind: 'RESOLVED', nitradoConnId: id };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveDashboardGameServer.mockResolvedValue(resolved());
  prismaMock.nitradoConnection.findFirst.mockResolvedValue({ id: CONN, keepOnlineEnabled: true });
  tryAcquireNitradoConfigMutationLock.mockResolvedValue({ release: releaseLock });
  txMock.serverSettings.upsert.mockResolvedValue(settingsRow);
  txMock.nitradoConnection.updateMany.mockResolvedValue({ count: 1 });
  cancelPendingKeepOnlineJobs.mockResolvedValue(1);
});

describe('Nitrado-1F keep-online config/worker lock', () => {
  it('returns 409 NITRADO_CONNECTION_BUSY when a worker already owns the connection lock', async () => {
    tryAcquireNitradoConfigMutationLock.mockResolvedValue(null);

    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/dashboard/server/1/settings`)
      .send({ permaOnly: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_CONNECTION_BUSY');
    expect(tryAcquireNitradoConfigMutationLock).toHaveBeenCalledWith(CONN);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(cancelPendingKeepOnlineJobs).not.toHaveBeenCalled();
  });

  it('holds the shared lock across fresh scope validation, toggle write and pending-job cancel', async () => {
    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/dashboard/server/1/settings`)
      .send({ permaOnly: false });

    expect(res.status).toBe(200);
    expect(resolveDashboardGameServer).toHaveBeenCalledTimes(2);
    expect(prismaMock.nitradoConnection.findFirst).toHaveBeenCalledTimes(2);
    expect(txMock.nitradoConnection.updateMany).toHaveBeenCalledWith({
      where: { id: CONN, guildId: GUILD },
      data: { keepOnlineEnabled: false },
    });
    expect(cancelPendingKeepOnlineJobs).toHaveBeenCalledWith(txMock, {
      guildId: GUILD,
      nitradoConnId: CONN,
    });
    expect(releaseLock).toHaveBeenCalledTimes(1);

    const acquireOrder = tryAcquireNitradoConfigMutationLock.mock.invocationCallOrder[0];
    const transactionOrder = prismaMock.$transaction.mock.invocationCallOrder[0];
    const releaseOrder = releaseLock.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(transactionOrder);
    expect(transactionOrder).toBeLessThan(releaseOrder);
  });

  it('fails closed on delete/recreate of the selected slot before lock acquisition completes', async () => {
    resolveDashboardGameServer
      .mockResolvedValueOnce(resolved(CONN))
      .mockResolvedValueOnce(resolved(REPLACEMENT));
    prismaMock.nitradoConnection.findFirst
      .mockResolvedValueOnce({ id: CONN, keepOnlineEnabled: true })
      .mockResolvedValueOnce({ id: REPLACEMENT, keepOnlineEnabled: false });

    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/dashboard/server/1/settings`)
      .send({ permaOnly: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_SLOT_VERSION_CONFLICT');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not take the Nitrado connection lock for unrelated server-settings writes', async () => {
    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/dashboard/server/1/settings`)
      .send({ whitelistActive: false });

    expect(res.status).toBe(200);
    expect(tryAcquireNitradoConfigMutationLock).not.toHaveBeenCalled();
    expect(resolveDashboardGameServer).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(releaseLock).not.toHaveBeenCalled();
  });
});
