import express from 'express';
import session from 'express-session';
import request from 'supertest';

const findUnique = jest.fn();
const prismaMock = { session: { findUnique } };

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  logAuditDb: jest.fn(),
}));

import { requireActivePersistentSession } from '../../src/dashboard/middleware/activePersistentSession';

type SessionData = {
  userId?: string;
  discordId?: string;
  sessionToken?: string;
  requires2FA?: boolean;
  twoFactorVerified?: boolean;
};

function appWithSession(sessionData: SessionData) {
  const app = express();
  app.use(session({ secret: 'active-session-test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    Object.assign(req.session, sessionData);
    next();
  });
  app.get('/active', requireActivePersistentSession, (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pending-2FA persistent application session gate', () => {
  it('rejects a request without an authenticated cookie identity', async () => {
    const res = await request(appWithSession({})).get('/active');
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects legacy cookie state without a persistent session token', async () => {
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: 'test-discord-user',
    })).get('/active');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects revoked, expired and mismatched persistent sessions', async () => {
    const base = {
      userId: 'u1',
      discordId: 'test-discord-user',
      sessionToken: 'session-1',
      requires2FA: true,
      twoFactorVerified: false,
    };

    findUnique.mockResolvedValueOnce({ isActive: false, expiresAt: new Date(Date.now() + 60_000), userId: 'u1' });
    expect((await request(appWithSession(base)).get('/active')).status).toBe(401);

    findUnique.mockResolvedValueOnce({ isActive: true, expiresAt: new Date(Date.now() - 60_000), userId: 'u1' });
    expect((await request(appWithSession(base)).get('/active')).status).toBe(401);

    findUnique.mockResolvedValueOnce({ isActive: true, expiresAt: new Date(Date.now() + 60_000), userId: 'other' });
    expect((await request(appWithSession(base)).get('/active')).status).toBe(401);
  });

  it('fails closed when the persistent session store cannot be queried', async () => {
    findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: 'test-discord-user',
      sessionToken: 'session-1',
    })).get('/active');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SESSION_STORE_UNAVAILABLE');
  });

  it('allows an active matching session while the second factor is still pending', async () => {
    findUnique.mockResolvedValueOnce({
      isActive: true,
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'u1',
    });
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: 'test-discord-user',
      sessionToken: 'session-1',
      requires2FA: true,
      twoFactorVerified: false,
    })).get('/active');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});