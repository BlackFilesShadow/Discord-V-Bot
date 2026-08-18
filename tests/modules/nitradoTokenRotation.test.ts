process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-003 / Nitrado-1A:
 * - bestehende Service-ID wird gegen den NEUEN Token geprueft
 * - nachgewiesener Mismatch -> Token + Service-Reset atomar
 * - technischer Service-Recheck-Fehler -> Rotation fail-closed, kein DB-Write
 */
const GID = '999999999999999999';
const ACTOR = '888888888888888888';

const getSlotMock = jest.fn(async (..._a: unknown[]) => null as unknown);
const updateTokenMock = jest.fn(async (..._a: unknown[]) => ({ slot: 1, alias5: 'ABCDE', status: 'ACTIVE' }));
const updateServiceIdMock = jest.fn(async (..._a: unknown[]) => ({}));
const createSlotMock = jest.fn(async (..._a: unknown[]) => ({ id: 'conn-1', slot: 1, alias: 'A', alias5: 'ABCDE', status: 'ACTIVE' }));
jest.mock('../../src/modules/nitrado/repository', () => ({
  __esModule: true,
  listSlots: jest.fn(),
  createSlot: (...a: unknown[]) => createSlotMock(...a),
  deleteSlot: jest.fn(),
  getSlot: (...a: unknown[]) => getSlotMock(...a),
  getDecryptedToken: jest.fn(),
  updateToken: (...a: unknown[]) => updateTokenMock(...a),
  updateAlias: jest.fn(),
  updateServiceId: (...a: unknown[]) => updateServiceIdMock(...a),
}));

const validateTokenMock = jest.fn();
const listServicesMock = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoClient: jest.fn().mockImplementation(() => ({
    validateToken: validateTokenMock,
    validateTokenDetailed: async () => ((await validateTokenMock()) ? { kind: 'VALID' } : { kind: 'INVALID', status: 401 }),
    listServices: listServicesMock,
  })),
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildOwner: (req: { auth?: unknown; guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', discordId: ACTOR, role: 'USER' };
    req.guildScope = { guildId: GID, actorDiscordId: ACTOR, permissions: [] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { nitradoRouter } from '../../src/dashboard/routes/v2/nitrado';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/nitrado', nitradoRouter);
  return app;
}
const URL = `/api/v2/guilds/${GID}/nitrado/1/token`;
const TOKEN = 'a'.repeat(40);

beforeEach(() => {
  jest.clearAllMocks();
  validateTokenMock.mockResolvedValue(true);
  createSlotMock.mockResolvedValue({ id: 'conn-1', slot: 1, alias: 'A', alias5: 'ABCDE', status: 'ACTIVE' });
});

describe('NIT-003 — Service-ID-Recheck bei Tokenrotation', () => {
  it('resetet die Service-ID atomar mit der Tokenrotation, wenn sie nicht zum neuen Token gehoert', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockResolvedValue([{ id: 999 }, { id: 888 }]);

    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.serviceReset).toBe(true);
    expect(updateTokenMock).toHaveBeenCalledWith(GID, 1, TOKEN, { resetServiceId: true });
    expect(updateServiceIdMock).not.toHaveBeenCalled();
  });

  it('behaelt die Service-ID, wenn sie zum neuen Token gehoert', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockResolvedValue([{ id: 123 }, { id: 456 }]);

    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.serviceReset).toBe(false);
    expect(updateTokenMock).toHaveBeenCalledWith(GID, 1, TOKEN, { resetServiceId: false });
    expect(updateServiceIdMock).not.toHaveBeenCalled();
  });

  it('bricht bei technischem Service-Recheck fail-closed ab und persistiert den neuen Token nicht', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockRejectedValue(new Error('network'));

    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Token wurde nicht geändert/);
    expect(updateTokenMock).not.toHaveBeenCalled();
    expect(updateServiceIdMock).not.toHaveBeenCalled();
  });

  it('rotiert ohne Service-Recheck, wenn der Slot nicht an eine Service-ID gebunden ist', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: null, alias5: 'ABCDE' });

    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(listServicesMock).not.toHaveBeenCalled();
    expect(updateTokenMock).toHaveBeenCalledWith(GID, 1, TOKEN, { resetServiceId: false });
  });
});

describe('Nitrado-Slot create race', () => {
  it('mappt einen DB-Unique-Race auf 409 statt 500', async () => {
    getSlotMock.mockResolvedValue(null);
    listServicesMock.mockResolvedValue([]);
    createSlotMock.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await request(makeApp())
      .post(`/api/v2/guilds/${GID}/nitrado`)
      .send({ slot: 1, alias: 'A', token: TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bereits belegt/);
  });
});
