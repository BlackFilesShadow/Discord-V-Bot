process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * P1-Sicherheits-Regression: Schreibende Whitelist-Aktionen erzeugen
 * NitradoJobs und muessen bei aktivem Schreibschutz Confirm + Reason verlangen.
 * Die lokalen Lifecycle-Aenderungen laufen atomar in derselben Transaktion.
 */

const GID = '999999999999999999';
const CONN_ID = 'caaaaaaaaaaaaaaaaaaaaaaaa';

const txStub = {
  whitelistEntry: {
    create: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    upsert: jest.fn().mockResolvedValue({}),
  },
  nitradoJob: { create: jest.fn().mockResolvedValue({}) },
  whitelistRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

const prismaMock = {
  nitradoConnection: {
    findMany: jest.fn().mockResolvedValue([
      { id: CONN_ID, slot: 1, alias: 'Slot 1', status: 'ACTIVE', nitradoServerId: 'srv-1' },
    ]),
    findUnique: jest.fn().mockResolvedValue({ id: CONN_ID }),
    findFirst: jest.fn().mockResolvedValue({ id: CONN_ID }),
  },
  whitelistEntry: { upsert: jest.fn().mockResolvedValue({}) },
  nitradoJob: { create: jest.fn().mockResolvedValue({}) },
  whitelistRequest: {
    findFirst: jest.fn().mockResolvedValue({
      id: 'req-1', guildId: GID, nitradoConnId: CONN_ID, gameId: 'PlayerX',
      requesterDiscordId: '123456789012345678', messageId: null, channelId: null,
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  $transaction: jest.fn(async (fn: (tx: typeof txStub) => Promise<unknown>) => fn(txStub)),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));

jest.mock('../../src/modules/nitrado/repository', () => ({ __esModule: true, getDecryptedToken: jest.fn() }));
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({ __esModule: true, NitradoClient: jest.fn() }));

jest.mock('../../src/modules/whitelist/whitelistChannels.js', () => ({
  __esModule: true,
  notifyRequesterDecision: jest.fn().mockResolvedValue(undefined),
  postDecisionLog: jest.fn().mockResolvedValue(undefined),
  finalizeApprovalEmbed: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (
    req: { auth?: unknown; guildScope?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = { userId: 'user-1', discordId: '888888888888888888', role: 'USER' };
    req.guildScope = { guildId: GID, actorDiscordId: '888888888888888888', permissions: ['whitelist.manage'] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { config } from '../../src/config';
import { whitelistRouter } from '../../src/dashboard/routes/v2/whitelist';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/whitelist', whitelistRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = `/api/v2/guilds/${GID}/whitelist`;

let originalProtection: boolean;

beforeAll(() => {
  originalProtection = config.nitrado.writeProtection;
  (config.nitrado as { writeProtection: boolean }).writeProtection = true;
});

afterAll(() => {
  (config.nitrado as { writeProtection: boolean }).writeProtection = originalProtection;
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.nitradoConnection.findMany.mockResolvedValue([
    { id: CONN_ID, slot: 1, alias: 'Slot 1', status: 'ACTIVE', nitradoServerId: 'srv-1' },
  ]);
  prismaMock.nitradoConnection.findUnique.mockResolvedValue({ id: CONN_ID });
  prismaMock.nitradoConnection.findFirst.mockResolvedValue({ id: CONN_ID });
  prismaMock.whitelistRequest.findFirst.mockResolvedValue({
    id: 'req-1', guildId: GID, nitradoConnId: CONN_ID, gameId: 'PlayerX',
    requesterDiscordId: '123456789012345678', messageId: null, channelId: null,
  });
  txStub.whitelistRequest.updateMany.mockResolvedValue({ count: 1 });
  txStub.whitelistEntry.updateMany.mockResolvedValue({ count: 1 });
  txStub.whitelistEntry.create.mockResolvedValue({});
  txStub.whitelistEntry.upsert.mockResolvedValue({});
  txStub.nitradoJob.create.mockResolvedValue({});
});

describe('Whitelist Write-Guard — Schreibschutz aktiv', () => {
  it('POST / ohne confirm -> 412 NITRADO_WRITE_PROTECTED, kein DB-Write', async () => {
    const r = await request(makeApp()).post(`${BASE}?slot=1`).send({ gameId: 'PlayerX' });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('NITRADO_WRITE_PROTECTED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('POST / mit confirm ohne reason -> 412 REASON_REQUIRED', async () => {
    const r = await request(makeApp()).post(`${BASE}?slot=1`).send({ gameId: 'PlayerX', confirm: true });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('NITRADO_WRITE_REASON_REQUIRED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('POST / mit confirm + reason -> 201, Job atomar erstellt', async () => {
    const r = await request(makeApp()).post(`${BASE}?slot=1`).send({ gameId: 'PlayerX', confirm: true, reason: 'Neuer Spieler' });
    expect(r.status).toBe(201);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txStub.nitradoJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'WHITELIST_ADD' }) }),
    );
  });

  it('DELETE /:gameId ohne confirm -> 412, kein DB-Write', async () => {
    const r = await request(makeApp()).delete(`${BASE}/PlayerX?slot=1`).send({});
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('NITRADO_WRITE_PROTECTED');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('DELETE /:gameId mit confirm + reason -> PENDING_REMOVE + Remove-Job atomar', async () => {
    const r = await request(makeApp()).delete(`${BASE}/PlayerX?slot=1`).send({ confirm: true, reason: 'Entfernt' });
    expect(r.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txStub.whitelistEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
    }));
    expect(txStub.nitradoJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'WHITELIST_REMOVE' }) }),
    );
  });

  it('POST /requests/:id/decision approve ohne confirm -> 412, kein CAS', async () => {
    const r = await request(makeApp()).post(`${BASE}/requests/req-1/decision?slot=1`).send({ approve: true });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('NITRADO_WRITE_PROTECTED');
    expect(txStub.whitelistRequest.updateMany).not.toHaveBeenCalled();
  });

  it('POST /requests/:id/decision approve mit confirm + reason -> CAS + Entry + Job in einer Transaktion', async () => {
    const r = await request(makeApp()).post(`${BASE}/requests/req-1/decision?slot=1`).send({ approve: true, confirm: true, reason: 'Genehmigt' });
    expect(r.status).toBe(200);
    expect(txStub.whitelistRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(txStub.whitelistEntry.upsert).toHaveBeenCalledTimes(1);
    expect(txStub.nitradoJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ operation: 'WHITELIST_ADD' }) }),
    );
  });

  it('POST /requests/:id/decision deny bleibt ungated und erzeugt keinen Nitrado-Job', async () => {
    const r = await request(makeApp()).post(`${BASE}/requests/req-1/decision?slot=1`).send({ approve: false });
    expect(r.status).toBe(200);
    expect(txStub.whitelistRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(txStub.nitradoJob.create).not.toHaveBeenCalled();
  });
});