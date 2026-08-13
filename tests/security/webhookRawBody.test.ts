process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * F-001/F-002 Regression:
 * - HMAC wird ueber Timestamp + Original-Rohbytes berechnet.
 * - Timestamp muss frisch sein.
 * - derselbe authentisierte Request darf persistent nur einmal zugestellt werden.
 * - bei Downstream-Fehlern wird der Replay-Claim freigegeben, damit ein echter Retry moeglich bleibt.
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

const claimed = new Set<string>();
const prismaMock = {
  feed: {
    findUnique: jest.fn(async () => feedRow),
    update: jest.fn(async () => feedRow),
  },
  idempotencyKey: {
    create: jest.fn(async ({ data }: { data: { hash: string } }) => {
      if (claimed.has(data.hash)) {
        const error = new Error('duplicate') as Error & { code?: string };
        error.code = 'P2002';
        throw error;
      }
      claimed.add(data.hash);
      return data;
    }),
    update: jest.fn(async ({ where }: { where: { hash: string } }) => ({ hash: where.hash })),
    delete: jest.fn(async ({ where }: { where: { hash: string } }) => {
      claimed.delete(where.hash);
      return { hash: where.hash };
    }),
  },
  $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
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

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function sign(body: string, timestamp: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  channelSend.mockReset().mockResolvedValue({ id: 'msg-1' });
  claimed.clear();
  setWebhookClient(fakeClient);
});

describe('F-001/F-002 — Webhook raw body, signed timestamp and replay protection', () => {
  it('akzeptiert einen korrekt signierten frischen Body (200)', async () => {
    const body = JSON.stringify({ title: 'Hallo Welt', description: 'Test' });
    const timestamp = nowTimestamp();
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Signature', sign(body, timestamp))
      .send(body);
    expect(res.status).toBe(200);
    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(prismaMock.idempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  it('lehnt einen manipulierten Body ab (401)', async () => {
    const original = JSON.stringify({ title: 'Original' });
    const timestamp = nowTimestamp();
    const signature = sign(original, timestamp);
    const tampered = JSON.stringify({ title: 'Manipuliert' });
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Signature', signature)
      .send(tampered);
    expect(res.status).toBe(401);
    expect(channelSend).not.toHaveBeenCalled();
  });

  it('lehnt eine falsche Signatur ab (401)', async () => {
    const body = JSON.stringify({ title: 'Hallo' });
    const timestamp = nowTimestamp();
    const res = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Signature', 'sha256=' + 'f'.repeat(64))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('lehnt fehlende und abgelaufene Timestamps ab', async () => {
    const body = JSON.stringify({ title: 'Hallo' });
    const fresh = nowTimestamp();
    const missing = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Signature', sign(body, fresh))
      .send(body);
    expect(missing.status).toBe(401);

    const old = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
    const expired = await request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', old)
      .set('X-V-Webhook-Signature', sign(body, old))
      .send(body);
    expect(expired.status).toBe(401);
    expect(channelSend).not.toHaveBeenCalled();
  });

  it('blockiert denselben authentisierten Request beim zweiten Versuch persistent (409)', async () => {
    const body = JSON.stringify({ title: 'Genau einmal' });
    const timestamp = nowTimestamp();
    const send = () => request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Signature', sign(body, timestamp))
      .send(body);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(channelSend).toHaveBeenCalledTimes(1);
  });

  it('gibt den Replay-Claim nach Discord-Fehler frei und erlaubt denselben Retry', async () => {
    const body = JSON.stringify({ title: 'Retry after failure' });
    const timestamp = nowTimestamp();
    const send = () => request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Signature', sign(body, timestamp))
      .send(body);

    channelSend.mockRejectedValueOnce(new Error('Discord unavailable'));
    expect((await send()).status).toBe(502);
    expect(prismaMock.idempotencyKey.delete).toHaveBeenCalledTimes(1);
    expect(claimed.size).toBe(0);

    expect((await send()).status).toBe(200);
    expect(channelSend).toHaveBeenCalledTimes(2);
    expect(prismaMock.idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('unterstuetzt Token-Fallback nur mit frischem Timestamp und Dedup', async () => {
    const body = JSON.stringify({ title: 'Token source' });
    const timestamp = nowTimestamp();
    const send = () => request(makeApp())
      .post(`/webhooks/feed/${FEED_ID}`)
      .set('Content-Type', 'application/json')
      .set('X-V-Webhook-Timestamp', timestamp)
      .set('X-V-Webhook-Token', SECRET)
      .send(body);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
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
