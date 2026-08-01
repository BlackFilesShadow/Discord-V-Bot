process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-003: Bei Tokenrotation wird die gespeicherte Service-ID gegen den NEUEN
 * Token geprueft. Gehoert sie nicht mehr zum Token -> Service-ID entfernen
 * (serviceReset=true), Owner muss neu auswaehlen.
 */
const GID = '999999999999999999';
const ACTOR = '888888888888888888';

const getSlotMock = jest.fn(async (..._a: unknown[]) => null as unknown);
const updateTokenMock = jest.fn(async (..._a: unknown[]) => ({ slot: 1, alias5: 'ABCDE', status: 'ACTIVE' }));
const updateServiceIdMock = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock('../../src/modules/nitrado/repository', () => ({
  __esModule: true,
  listSlots: jest.fn(), createSlot: jest.fn(), deleteSlot: jest.fn(),
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
});

describe('NIT-003 — Service-ID-Recheck bei Tokenrotation', () => {
  it('entfernt die Service-ID, wenn sie nicht zum neuen Token gehoert', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockResolvedValue([{ id: 999 }, { id: 888 }]);
    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.serviceReset).toBe(true);
    expect(updateServiceIdMock).toHaveBeenCalledWith(GID, 1, null);
  });

  it('behaelt die Service-ID, wenn sie zum neuen Token gehoert', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockResolvedValue([{ id: 123 }, { id: 456 }]);
    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.serviceReset).toBe(false);
    expect(updateServiceIdMock).not.toHaveBeenCalled();
  });

  it('wertet einen Netzwerkfehler beim Service-Listing NICHT als Mismatch', async () => {
    getSlotMock.mockResolvedValue({ nitradoServerId: '123', alias5: 'ABCDE' });
    listServicesMock.mockRejectedValue(new Error('network'));
    const res = await request(makeApp()).patch(URL).send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.serviceReset).toBe(false);
    expect(updateServiceIdMock).not.toHaveBeenCalled();
  });
});
