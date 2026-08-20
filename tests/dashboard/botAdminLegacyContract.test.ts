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
const PACKAGE_ID = '22222222-2222-4222-8222-222222222222';
const APPEAL_ID = '33333333-3333-4333-8333-333333333333';
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  session.active = true;
});

describe('Dashboard-1X/1Y strict pagination/filter/search contract', () => {
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
    '/packages?q=alpha&q=beta',
    '/users?q=alpha&q=beta',
  ])('rejects repeated search parameters instead of silently widening: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/genau einmal/);
  });

  it.each([
    `/packages?q=${'x'.repeat(201)}`,
    `/users?q=${'x'.repeat(201)}`,
  ])('rejects unbounded search parameters: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/maximal 200/);
  });

  it.each([
    '/appeals?page=1&pageSize=100&status=pending',
    '/feedback?status=resolved',
    '/packages?status=active&q=alpha',
    '/tickets?status=closed',
    '/users?filter=manufacturer&q=123456',
  ])('allows canonical values and falls through: %s', async path => {
    const r = await request(app()).get(`${BASE}${path}`);
    expect(r.status).toBe(204);
  });
});

describe('Dashboard-1X/1Y mutation body contract', () => {
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

  it.each([
    { path: `/appeals/${APPEAL_ID}/decision`, method: 'post', body: { decision: ['APPROVED'] } },
    { path: `/feedback/${FEEDBACK_ID}`, method: 'patch', body: { status: ['RESOLVED'] } },
    { path: '/broadcast', method: 'post', body: { target: ['ALL'], message: 'Test' } },
    { path: '/export', method: 'post', body: { type: ['users'] } },
    { path: `/packages/${PACKAGE_ID}/status`, method: 'post', body: { status: ['ACTIVE'] } },
    { path: `/users/${USER_ID}/manufacturer`, method: 'post', body: { decision: ['APPROVE'] } },
  ])('rejects coercible non-string enum payloads: $method $path', async ({ path, method, body }) => {
    const agent = request(app());
    const r = method === 'patch'
      ? await agent.patch(`${BASE}${path}`).send(body)
      : await agent.post(`${BASE}${path}`).send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ungueltig/);
  });

  it.each([
    { path: `/appeals/${APPEAL_ID}/decision`, method: 'post', body: { decision: 'approved', note: 'ok' } },
    { path: `/feedback/${FEEDBACK_ID}`, method: 'patch', body: { status: 'resolved', adminNote: null } },
    { path: '/broadcast', method: 'post', body: { target: 'all', message: 'Test', dryRun: false } },
    { path: '/export', method: 'post', body: { type: 'users' } },
    { path: `/packages/${PACKAGE_ID}/status`, method: 'post', body: { status: 'active' } },
    { path: `/users/${USER_ID}/manufacturer`, method: 'post', body: { decision: 'approve', note: 'ok' } },
  ])('accepts canonical string enum payloads: $method $path', async ({ path, method, body }) => {
    const agent = request(app());
    const r = method === 'patch'
      ? await agent.patch(`${BASE}${path}`).send(body)
      : await agent.post(`${BASE}${path}`).send(body);
    expect(r.status).toBe(204);
  });

  it.each([
    { path: `/appeals/${APPEAL_ID}/decision`, body: { decision: 'DENIED', note: 'x'.repeat(1001) }, method: 'post', field: 'note' },
    { path: `/feedback/${FEEDBACK_ID}`, body: { status: 'RESOLVED', adminNote: 'x'.repeat(2001) }, method: 'patch', field: 'adminNote' },
    { path: `/users/${USER_ID}/toggle-upload`, body: { enable: false, reason: 'x'.repeat(501) }, method: 'post', field: 'reason' },
    { path: `/users/${USER_ID}/manufacturer`, body: { decision: 'DENY', note: 'x'.repeat(501) }, method: 'post', field: 'note' },
  ])('rejects overlong operator text instead of silently truncating: $field', async ({ path, body, method, field }) => {
    const agent = request(app());
    const r = method === 'patch'
      ? await agent.patch(`${BASE}${path}`).send(body)
      : await agent.post(`${BASE}${path}`).send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(field);
    expect(r.body.error).toMatch(/maximal/);
  });

  it.each([
    {},
    { hard: 'true' },
    { hard: 'false' },
  ])('accepts unambiguous package delete hard query %#', async query => {
    const r = await request(app()).delete(`${BASE}/packages/${PACKAGE_ID}`).query(query);
    expect(r.status).toBe(204);
  });

  it.each([
    '?hard=True',
    '?hard=1',
    '?hard=true&hard=false',
  ])('rejects ambiguous package delete hard query: %s', async query => {
    const r = await request(app()).delete(`${BASE}/packages/${PACKAGE_ID}${query}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/true oder false/);
  });

  it('rejects malformed optional broadcast dryRun', async () => {
    const bad = await request(app()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'Test', dryRun: 'false' });
    const omitted = await request(app()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'Test' });
    const exact = await request(app()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'Test', dryRun: false });
    expect(bad.status).toBe(400);
    expect(omitted.status).toBe(204);
    expect(exact.status).toBe(204);
  });

  it('rejects blank/oversized broadcast message before legacy coercion', async () => {
    const blank = await request(app()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: '   ' });
    const huge = await request(app()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'x'.repeat(1901) });
    expect(blank.status).toBe(400);
    expect(huge.status).toBe(400);
  });

  it('authenticates before revealing validation errors', async () => {
    session.active = false;
    const r = await request(app()).post(`${BASE}/broadcast`).send({ target: ['ALL'], message: 123, dryRun: 'true' });
    expect(r.status).toBe(403);
  });
});
