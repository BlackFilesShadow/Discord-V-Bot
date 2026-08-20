import express from 'express';
import request from 'supertest';

const session = { active: true };

jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireBotAdmin: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!session.active) {
      res.status(403).json({ error: 'Bot-Admin-Session erforderlich.' });
      return;
    }
    next();
  },
}));

import { botAdminLegacyContractRouter } from '../../src/dashboard/routes/v2/botAdminLegacyContract';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/bot-admin', botAdminLegacyContractRouter);
  instance.use((_req, res) => res.status(204).end());
  return instance;
}

const BASE = '/api/v2/bot-admin';
const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  session.active = true;
});

describe('Dashboard-1X strict pagination/filter contract', () => {
  it.each([
    '/appeals?page=1foo',
    '/feedback?page=0',
    '/validate?page=-1',
    '/packages?pageSize=101',
    '/users?pageSize=2.5',
    '/tickets?page=1&page=2',
  ])('rejects malformed pagination: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(400);
  });

  it.each([
    '/appeals?status=UNKNOWN',
    '/feedback?status=UNKNOWN',
    '/packages?status=UNKNOWN',
    '/tickets?status=UNKNOWN',
    '/users?filter=UNKNOWN',
  ])('rejects unknown filters instead of widening the query: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(400);
  });

  it.each([
    '/appeals?page=1&pageSize=100&status=pending',
    '/feedback?status=resolved',
    '/packages?status=active',
    '/tickets?status=closed',
    '/users?filter=manufacturer',
  ])('allows canonical values and falls through: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(204);
  });
});

describe('Dashboard-1X mutation body contract', () => {
  it.each([
    { path: '/upload/toggle', body: {} },
    { path: '/upload/toggle', body: { enable: 'true' } },
    { path: `/users/${USER_ID}/toggle-upload`, body: { enable: 1 } },
    { path: `/users/${USER_ID}/toggle-upload`, body: { enable: null } },
  ])('rejects non-boolean enable payloads: $path', async ({ path, body }) => {
    const r = await request(app()).post(`${BASE}${path}`).send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/true oder false/);
  });

  it.each([true, false])('accepts exact boolean enable=%s', async enable => {
    const upload = await request(app()).post(`${BASE}/upload/toggle`).send({ enable });
    const user = await request(app()).post(`${BASE}/users/${USER_ID}/toggle-upload`).send({ enable });
    expect(upload.status).toBe(204);
    expect(user.status).toBe(204);
  });

  it.each([
    { expiryMinutes: '30x' },
    { expiryMinutes: 4 },
    { expiryMinutes: 1441 },
    { expiryMinutes: 30.5 },
  ])('rejects malformed reset expiry %#', async body => {
    const r = await request(app()).post(`${BASE}/users/${USER_ID}/reset-password`).send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/5 und 1440/);
  });

  it.each([{ expiryMinutes: 30 }, { expiryMinutes: '30' }, {}])('accepts strict/default reset expiry %#', async body => {
    const r = await request(app()).post(`${BASE}/users/${USER_ID}/reset-password`).send(body);
    expect(r.status).toBe(204);
  });

  it('rejects malformed optional broadcast dryRun', async () => {
    const bad = await request(app()).post(`${BASE}/broadcast`).send({ dryRun: 'false' });
    const omitted = await request(app()).post(`${BASE}/broadcast`).send({});
    const exact = await request(app()).post(`${BASE}/broadcast`).send({ dryRun: false });
    expect(bad.status).toBe(400);
    expect(omitted.status).toBe(204);
    expect(exact.status).toBe(204);
  });

  it('authenticates before revealing validation errors', async () => {
    session.active = false;
    const r = await request(app()).post(`${BASE}/upload/toggle`).send({ enable: 'true' });
    expect(r.status).toBe(403);
  });
});
