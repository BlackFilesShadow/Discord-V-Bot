process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';
process.env.DEV_PASSWORD = 'dev-password-123';
process.env.DEV_REQUIRE_MFA = 'false';
process.env.DEV_REQUIRE_IP_ALLOWLIST = 'false';

const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockTwoFactorFindUnique = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: {
      findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args),
      updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args),
    },
    twoFactorAuth: {
      findUnique: (...args: unknown[]) => mockTwoFactorFindUnique(...args),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth } from '../../src/dashboard/middleware/auth';
import {
  devIncidentRouter,
  OPERATIONAL_INCIDENT_ACTIONS,
} from '../../src/dashboard/routes/v2/devIncident';
import {
  __resetIncidentStateForTests,
  isIncidentActive,
} from '../../src/dashboard/services/incidentResponse';

const DEV_DISCORD_ID = '123456789012345678';

function activeSession() {
  const now = Date.now();
  return {
    id: 'dev-session-stage27',
    userDiscordId: DEV_DISCORD_ID,
    scope: {},
    createdAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60 * 1000),
  };
}

function appFor() {
  mockDevSessionFindFirst.mockResolvedValue(activeSession());
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    Object.assign(req.session, {
      userId: 'u1',
      discordId: DEV_DISCORD_ID,
      role: 'DEVELOPER',
    });
    next();
  });
  app.use('/api/v2', requireAuth);
  app.use('/api/v2/dev/incident', devIncidentRouter);
  return app;
}

function activateBody(reAuth: string) {
  return {
    action: 'kill.ai',
    reason: 'Stage 27 verified incident action',
    reAuth,
    idempotencyKey: 'stage27-incident-activate-0001',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetIncidentStateForTests();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockTwoFactorFindUnique.mockResolvedValue({ isEnabled: false, secretEnc: null });
});

afterAll(() => {
  __resetIncidentStateForTests();
});

describe('Stage 27 DEV incident action contract', () => {
  it('advertises only actions with proven production side effects', async () => {
    expect(OPERATIONAL_INCIDENT_ACTIONS).toEqual([]);

    const response = await request(appFor()).get('/api/v2/dev/incident/state');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.operationalActions).toEqual([]);
  });

  it('rejects wrong re-auth before any incident action decision or state change', async () => {
    const response = await request(appFor())
      .post('/api/v2/dev/incident/activate')
      .send(activateBody('wrong-password'));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('reauth_invalid');
    expect(mockTwoFactorFindUnique).toHaveBeenCalledTimes(1);
    expect(isIncidentActive('kill.ai')).toBe(false);
  });

  it('fails closed after valid DEV re-auth when a toggle has no runtime consumer', async () => {
    const response = await request(appFor())
      .post('/api/v2/dev/incident/activate')
      .send(activateBody('dev-password-123'));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: 'incident_action_not_operational' });
    expect(isIncidentActive('kill.ai')).toBe(false);
  });

  it('fails closed for deactivation of an action that is not operationally exposed', async () => {
    const response = await request(appFor())
      .post('/api/v2/dev/incident/deactivate')
      .send({ action: 'kill.ai', reason: 'Stage 27 valid deactivation', reAuth: 'dev-password-123' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: 'incident_action_not_operational' });
    expect(isIncidentActive('kill.ai')).toBe(false);
  });

  it('rejects wrong re-auth before one-shot availability is disclosed', async () => {
    const response = await request(appFor())
      .post('/api/v2/dev/incident/oneshot')
      .send({
        action: 'cache.flush',
        reason: 'Stage 27 reject bad one shot reauth',
        reAuth: 'wrong-password',
        idempotencyKey: 'stage27-oneshot-reject-0001',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('reauth_invalid');
  });

  it.each(['cache.flush', 'backup.trigger'] as const)(
    'fails closed for %s because no production side effect is wired',
    async action => {
      const response = await request(appFor())
        .post('/api/v2/dev/incident/oneshot')
        .send({
          action,
          reason: `Stage 27 unavailable ${action}`,
          reAuth: 'dev-password-123',
          idempotencyKey: `stage27-${action.replace('.', '-')}-0001`,
        });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ ok: false, error: 'incident_action_not_operational' });
    },
  );
});
