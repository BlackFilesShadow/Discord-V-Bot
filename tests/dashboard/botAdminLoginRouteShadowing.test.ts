process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

// requireBotAdmin simuliert den realen "kein Login, keine DEV-Session"-Fall:
// 403, wie requireBotAdmin es fuer einen Erstaufruf ohne aktive Session tut.
jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(403).json({ error: 'DEV-Session erforderlich.', code: 'DEV_LOGIN_REQUIRED' });
  },
}));
jest.mock('../../src/dashboard/middleware/devStepUp', () => ({
  requireVerifiedDevMutationStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyDevStepUp: jest.fn(),
  statusFor: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { botAdminXpRetirementRouter } from '../../src/dashboard/routes/v2/botAdminXpRetirement';
import { botAdminDangerSafetyRouter } from '../../src/dashboard/routes/v2/botAdminDangerSafety';
import { botAdminSafeValidationRouter } from '../../src/dashboard/routes/v2/botAdminSafeValidation';
import { botAdminSafePackageDeleteRouter } from '../../src/dashboard/routes/v2/botAdminSafePackageDelete';

// Minimaler Ersatz fuer den echten botAdminRouter: nur die Routen, deren
// Erreichbarkeit dieser Test beweisen soll, ohne dessen schwere Abhaengigkeiten
// (Prisma, Discord-Client, ...) mitziehen zu muessen.
function stubBotAdminRouter() {
  const router = express.Router();
  router.post('/login', (req, res) => {
    if (!req.body?.password) { res.status(400).json({ error: 'password fehlt.' }); return; }
    res.status(403).json({ error: 'Passwort falsch.' });
  });
  router.get('/status', (_req, res) => { res.json({ active: false, expiresAt: null }); });
  return router;
}

// Bildet exakt die Mount-Reihenfolge aus src/dashboard/routes/v2.ts nach:
// v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminXpRetirementRouter,
//   botAdminDangerSafetyRouter, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter,
//   guardBotAdminGuildReferences, botAdminLegacyContractRouter, botAdminRouter);
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(
    '/bot-admin',
    botAdminXpRetirementRouter,
    botAdminDangerSafetyRouter,
    botAdminSafeValidationRouter,
    botAdminSafePackageDeleteRouter,
    stubBotAdminRouter(),
  );
  return instance;
}

describe('Bot-Admin: /login und /status duerfen nicht von den pfadfremden Safety-Override-Routern abgefangen werden', () => {
  it('POST /bot-admin/login erreicht den echten Login-Handler statt eines requireBotAdmin-403', async () => {
    const res = await request(app()).post('/bot-admin/login').send({ password: 'ASH1' });
    // 403 "Passwort falsch." vom echten Handler ist ok (falsches Test-Passwort);
    // entscheidend ist, dass NICHT der requireBotAdmin-Mock (DEV_LOGIN_REQUIRED) antwortet.
    expect(res.body.code).not.toBe('DEV_LOGIN_REQUIRED');
    expect(res.body.error).toBe('Passwort falsch.');
  });

  it('POST /bot-admin/login ohne Passwort erreicht ebenfalls den echten Handler (400, nicht 403 DEV_LOGIN_REQUIRED)', async () => {
    const res = await request(app()).post('/bot-admin/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password fehlt.');
  });

  it('GET /bot-admin/status erreicht den echten Status-Handler statt eines requireBotAdmin-403', async () => {
    const res = await request(app()).get('/bot-admin/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false, expiresAt: null });
  });

  it('/xp bleibt weiterhin hinter requireBotAdmin gesperrt', async () => {
    const res = await request(app()).get('/bot-admin/xp');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEV_LOGIN_REQUIRED');
  });

  it('/danger/purge-deleted-packages bleibt weiterhin hinter requireBotAdmin gesperrt', async () => {
    const res = await request(app()).post('/bot-admin/danger/purge-deleted-packages').send({ confirm: 'DELETE' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEV_LOGIN_REQUIRED');
  });

  it('/validate bleibt weiterhin hinter requireBotAdmin gesperrt', async () => {
    const res = await request(app()).post('/bot-admin/validate').send({ uploadId: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEV_LOGIN_REQUIRED');
  });

  it('DELETE /packages/:id bleibt weiterhin hinter requireBotAdmin gesperrt', async () => {
    const res = await request(app()).delete('/bot-admin/packages/abc123').query({ hard: 'true' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEV_LOGIN_REQUIRED');
  });
});
