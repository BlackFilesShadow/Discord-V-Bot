process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD = '999999999999999999';
const ACTOR = '888888888888888888';
const CONN = 'c123456789012345678901234';
const VERSION = new Date('2026-08-18T10:00:00.000Z');
const busyError = class NitradoConnectionBusyError extends Error {};

const getSlot = jest.fn();
const updateToken = jest.fn();
const updateServiceId = jest.fn();
const deleteSlot = jest.fn();

jest.mock('../../src/modules/nitrado/repository', () => ({
  listSlots: jest.fn(),
  createSlot: jest.fn(),
  deleteSlot: (...args: unknown[]) => deleteSlot(...args),
  getSlot: (...args: unknown[]) => getSlot(...args),
  getDecryptedToken: jest.fn(),
  updateToken: (...args: unknown[]) => updateToken(...args),
  updateAlias: jest.fn(),
  updateServiceId: (...args: unknown[]) => updateServiceId(...args),
  NitradoSlotVersionConflictError: class NitradoSlotVersionConflictError extends Error {},
  NitradoConnectionBusyError: busyError,
}));

const validateTokenDetailed = jest.fn();
const listServices = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    validateTokenDetailed,
    listServices,
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAuditDb: jest.fn(),
}));

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireGuildOwner: (req: { auth?: unknown; guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'u1', discordId: ACTOR, role: 'USER' };
    req.guildScope = { guildId: GUILD, actorDiscordId: ACTOR, permissions: [] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { nitradoRouter } from '../../src/dashboard/routes/v2/nitrado';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/guilds/:guildId/nitrado', nitradoRouter);
  return instance;
}

const SLOT = {
  id: CONN,
  slot: 1,
  nitradoServerId: null,
  alias5: 'ABCDE',
  updatedAt: VERSION,
};

beforeEach(() => {
  jest.clearAllMocks();
  getSlot.mockResolvedValue(SLOT);
  validateTokenDetailed.mockResolvedValue({ kind: 'VALID' });
  listServices.mockResolvedValue([]);
  updateToken.mockRejectedValue(new busyError());
  updateServiceId.mockRejectedValue(new busyError());
  deleteSlot.mockRejectedValue(new busyError());
});

describe('Nitrado-1C busy route contract', () => {
  it('returns 409 NITRADO_CONNECTION_BUSY for token rotation colliding with a worker', async () => {
    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/nitrado/1/token`)
      .send({ token: 'a'.repeat(40) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_CONNECTION_BUSY');
  });

  it('returns 409 NITRADO_CONNECTION_BUSY for service clearing colliding with a worker', async () => {
    const res = await request(app())
      .patch(`/api/v2/guilds/${GUILD}/nitrado/1/service`)
      .send({ nitradoServerId: null });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_CONNECTION_BUSY');
  });

  it('returns 409 NITRADO_CONNECTION_BUSY for slot delete colliding with a worker', async () => {
    const res = await request(app())
      .delete(`/api/v2/guilds/${GUILD}/nitrado/1`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NITRADO_CONNECTION_BUSY');
  });
});
