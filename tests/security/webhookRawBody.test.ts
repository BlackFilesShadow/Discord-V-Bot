process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * F-001 Regression: Der globale express.json()-Parser darf die HMAC-Pruefung
 * des Webhook-Endpunkts nicht zerstoeren. Die Signatur wird ueber die
 * Original-Rohbytes berechnet — nicht ueber ein re-serialisiertes JSON-Objekt.
 */

import crypto from 'crypto';

const FEED_ID = 'abcdef01-2345-6789-abcd-ef0123456789';
const SECRET = 'a'.repeat(64);
const CH = '222222222222222222';

const feedRow = {
  id: FEED_ID,
  isActive: true,
  feedType: 'WEBHOOK',
  webhookSecret: SECRET,
  channelId: CH,
  name: 'Test-Webhook',
  mentionRoles: [] as string[],
};

const prismaMock = {
  feed: {
    findUnique: jest.fn(async () => feedRow),
    update: jest.fn(async () => feedRow),
  },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  logAuditDb: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { webhookRouter, setWebhookClient } from '../../src/dashboard/routes/webhooks';

const channelSend = jest.fn().mockResolvedValue({ id: 'msg-1' });
const fakeClient = {
  channels: { fetch: jest.fn().mockResolvedValue({ send: channelSend }) },
} as unknown as Parameters<typeof setWebhookClient>[0];

/**
 * Baut die App exakt wie der produktive Server: globaler JSON-Parser MIT
 * verify-Hook, der die Rohbytes fuer die HMAC-Pruefung sichert.
 */
function makeApp() {
  const app = express();
  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
  }));
  app.use('/webhooks', webhookRouter);
  app.post('/echo', (req, res) => { res.json({ received: req.body }); });
  return app;
}

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  setWebhookClient(fakeClient);
});

describe('F-001 — Webhook-Rohbody / HMAC', () => {
  it('akzeptiert einen korrekt signierten Body (200)', async () => {
    const body = JSON.stringify({ title: 'Hallo Welt', description: 'Test' });
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Signature', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(channelSend).toHaveBeenCalledTimes(1);
  });

  it('lehnt einen manipulierten Body ab (401)', async () => {
    const original = JSON.stringify({ title: 'Original' });
    const signature = sign(original);
    const tampered = JSON.stringify({ title: 'Manipuliert' });
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Signature', signature)
      .send(tampered);
    expect(res.status).toBe(401);
    expect(channelSend).not.toHaveBeenCalled();
  });

  it('lehnt eine falsche Signatur ab (401)', async () => {
    const body = JSON.stringify({ title: 'Hallo' });
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Signature', 'sha256=' + 'f'.repeat(64))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('laesst den normalen JSON-Parser unveraendert', async () => {
    const res = await request(makeApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ hello: 'world' });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ hello: 'world' });
  });
});
