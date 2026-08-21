import express from 'express';
import request from 'supertest';
import { requireAuth } from '../../src/dashboard/middleware/auth';

const findUnique = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    session: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function appWithSession(session: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: {
        ...session,
        destroy: (cb: (err?: Error) => void) => {
          cb();
        },
      },
    });
    next();
  });
  app.get('/probe', requireAuth, (req, res) => {
    res.json({ ok: true, auth: req.auth });
  });
  return app;
}

describe('requireAuth Stage 36 session gate', () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it('rejects missing login', async () => {
    const res = await request(appWithSession({})).get('/probe');
    expect(res.status).toBe(401);
  });

  it('allows valid cookie without sessionToken (legacy shape)', async () => {
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: '123456789012345678',
      role: 'USER',
    })).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects revoked prisma session token', async () => {
    findUnique.mockResolvedValue({ isActive: false, expiresAt: new Date(Date.now() + 60_000), userId: 'u1' });
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: '123456789012345678',
      role: 'USER',
      sessionToken: 'tok-revoked',
    })).get('/probe');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    expect(findUnique).toHaveBeenCalled();
  });

  it('rejects expired prisma session token', async () => {
    findUnique.mockResolvedValue({ isActive: true, expiresAt: new Date(Date.now() - 1000), userId: 'u1' });
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: '123456789012345678',
      sessionToken: 'tok-exp',
    })).get('/probe');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
  });

  it('allows active matching prisma session', async () => {
    findUnique.mockResolvedValue({ isActive: true, expiresAt: new Date(Date.now() + 60_000), userId: 'u1' });
    const res = await request(appWithSession({
      userId: 'u1',
      discordId: '123456789012345678',
      role: 'ADMIN',
      sessionToken: 'tok-ok',
    })).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.auth.role).toBe('ADMIN');
  });
});
