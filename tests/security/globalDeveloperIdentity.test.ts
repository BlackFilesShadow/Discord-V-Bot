process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const OWNER_ID = '123456789012345678';

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: { discord: { ownerId: OWNER_ID } },
}));

const userFindUnique = jest.fn();
const devSessionUpdateMany = jest.fn(async () => ({ count: 1 }));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: userFindUnique },
    devSession: { updateMany: devSessionUpdateMany },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { NextFunction, Request, Response } from 'express';
import { isGlobalDeveloperEligible } from '../../src/modules/auth/globalDeveloperIdentity';
import { requireGlobalDeveloperIdentity } from '../../src/dashboard/middleware/globalDeveloperGate';

function makeRequest(discordId = OWNER_ID, role = 'DEVELOPER') {
  const session: Record<string, unknown> = { role };
  const req = {
    auth: { userId: 'user-1', discordId, role },
    session,
    ip: '127.0.0.1',
  } as unknown as Request;
  return { req, session };
}

function makeResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { res: { status } as unknown as Response, status, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  userFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
});

describe('Phase 10 — GlobalDeveloperIdentity', () => {
  it('akzeptiert nur exakte Owner-ID plus bereits vorhandene DEVELOPER-Rolle', () => {
    expect(isGlobalDeveloperEligible(OWNER_ID, 'DEVELOPER', OWNER_ID)).toBe(true);
    expect(isGlobalDeveloperEligible('999999999999999999', 'DEVELOPER', OWNER_ID)).toBe(false);
    expect(isGlobalDeveloperEligible(OWNER_ID, 'USER', OWNER_ID)).toBe(false);
    expect(isGlobalDeveloperEligible(OWNER_ID, 'DEVELOPER', '')).toBe(false);
  });

  it('laesst den kanonischen Developer mit frischer DB-Rolle passieren', async () => {
    const { req } = makeRequest();
    const { res, status } = makeResponse();
    const next = jest.fn() as NextFunction;

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(userFindUnique).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(devSessionUpdateMany).not.toHaveBeenCalled();
  });

  it('verweigert falsche Discord-ID und widerruft alte DevSessions', async () => {
    const { req } = makeRequest('999999999999999999', 'DEVELOPER');
    const { res, status, json } = makeResponse();
    const next = jest.fn() as NextFunction;

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEV_IDENTITY_REQUIRED' }));
    expect(devSessionUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('macht einen Rollenentzug aus der DB sofort wirksam', async () => {
    userFindUnique.mockResolvedValue({ role: 'USER' });
    const { req, session } = makeRequest(OWNER_ID, 'DEVELOPER');
    const { res, status } = makeResponse();
    const next = jest.fn() as NextFunction;

    await requireGlobalDeveloperIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect((req as unknown as { auth: { role: string } }).auth.role).toBe('USER');
    expect(session.role).toBe('USER');
    expect(devSessionUpdateMany).toHaveBeenCalledTimes(1);
  });
});
