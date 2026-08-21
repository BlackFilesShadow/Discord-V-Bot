process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD = '999999999999999999';
const ACTOR = '888888888888888888';
const CONN = 'c123456789012345678901234';

const createSlot = jest.fn();
const getSlot = jest.fn();

jest.mock('../../src/modules/nitrado/repository', () => ({
  listSlots: jest.fn(),
  createSlot: (...args: unknown[]) => createSlot(...args),
  deleteSlot: jest.fn(),
  getSlot: (...args: unknown[]) => getSlot(...args),
  getDecryptedToken: jest.fn(),
  updateToken: jest.fn(),
  updateAlias: jest.fn(),
  updateServiceId: jest.fn(),
  NitradoSlotVersionConflictError: class NitradoSlotVersionConflictError extends Error {},
  NitradoConnectionBusyError: class NitradoConnectionBusyError extends Error {},
}));

const validateTokenDetailed = jest.fn();
const listServices = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    validateTokenDetailed,
    listServices,
  })),
}));

const logAuditDb = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAuditDb: (...args: unknown[]) => logAuditDb(...args),
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

beforeEach(() => {
  jest.clearAllMocks();
  getSlot.mockResolvedValue(null);
  validateTokenDetailed.mockResolvedValue({ kind: 'VALID' });
  listServices.mockResolvedValue([]);
  createSlot.mockImplementation(async (args: { slot: number; alias: string }) => ({
    id: CONN,
    slot: args.slot,
    alias: args.alias,
    alias5: 'ABCDE',
    status: 'ACTIVE',
  }));
});

describe('Nitrado dashboard create CRUD contract', () => {
  it('rejects fractional slots before lookup, token validation, or persistence', async () => {
    const res = await request(app())
      .post(`/api/v2/guilds/${GUILD}/nitrado`)
      .send({ slot: 1.5, alias: 'Chernarus', token: 'a'.repeat(40) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('slot 1..5');
    expect(getSlot).not.toHaveBeenCalled();
    expect(validateTokenDetailed).not.toHaveBeenCalled();
    expect(createSlot).not.toHaveBeenCalled();
    expect(logAuditDb).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only alias before token validation or persistence', async () => {
    const res = await request(app())
      .post(`/api/v2/guilds/${GUILD}/nitrado`)
      .send({ slot: 1, alias: '   ', token: 'a'.repeat(40) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('alias 1..40');
    expect(validateTokenDetailed).not.toHaveBeenCalled();
    expect(createSlot).not.toHaveBeenCalled();
    expect(logAuditDb).not.toHaveBeenCalled();
  });

  it('normalizes surrounding alias whitespace before persistence and audit', async () => {
    const res = await request(app())
      .post(`/api/v2/guilds/${GUILD}/nitrado`)
      .send({ slot: 1, alias: '  Chernarus  ', token: 'a'.repeat(40) });

    expect(res.status).toBe(201);
    expect(createSlot).toHaveBeenCalledTimes(1);
    expect(createSlot).toHaveBeenCalledWith(expect.objectContaining({
      guildId: GUILD,
      slot: 1,
      alias: 'Chernarus',
      rawToken: 'a'.repeat(40),
      nitradoServerId: null,
      addedBy: ACTOR,
    }));
    expect(res.body.alias).toBe('Chernarus');
    expect(logAuditDb).toHaveBeenCalledWith(
      'NITRADO_SLOT_CREATED',
      'NITRADO',
      expect.objectContaining({
        guildId: GUILD,
        details: expect.objectContaining({ alias: 'Chernarus', slot: 1 }),
      }),
    );
  });
});
