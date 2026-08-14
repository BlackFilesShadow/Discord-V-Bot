process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const feed = {
  id: 'feed-1',
  name: 'Security Feed',
  isActive: true,
  feedType: 'WEBHOOK',
  webhookSecret: 'super-secret',
  channelId: 'channel-1',
  mentionRoles: [] as string[],
};

const prismaMock = {
  feed: {
    findUnique: jest.fn(async () => feed),
    update: jest.fn(async () => feed),
  },
  idempotencyKey: {
    create: jest.fn(async () => ({ hash: 'claim' })),
    update: jest.fn(async () => ({ hash: 'claim', status: 'DONE' })),
    delete: jest.fn(async () => ({ hash: 'claim' })),
  },
  $transaction: jest.fn(async () => []),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import type { Client } from 'discord.js';
import { deliverWebhookPayload } from '../../src/modules/feeds/webhookReceiver';

function currentTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function makeClient(send: jest.Mock): Client {
  return {
    channels: {
      fetch: jest.fn(async () => ({ send })),
    },
  } as unknown as Client;
}

function headers() {
  return {
    'x-v-webhook-timestamp': currentTimestamp(),
    'x-v-webhook-token': feed.webhookSecret,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.feed.findUnique.mockResolvedValue(feed);
  prismaMock.feed.update.mockResolvedValue(feed);
  prismaMock.idempotencyKey.create.mockResolvedValue({ hash: 'claim' });
  prismaMock.idempotencyKey.update.mockResolvedValue({ hash: 'claim', status: 'DONE' });
  prismaMock.idempotencyKey.delete.mockResolvedValue({ hash: 'claim' });
  prismaMock.$transaction.mockResolvedValue([]);
});

describe('F-002 — Webhook replay delivery semantics', () => {
  it('gibt den Replay-Claim frei, wenn Discord die Nachricht nicht annimmt', async () => {
    const send = jest.fn().mockRejectedValue(new Error('discord unavailable'));

    const result = await deliverWebhookPayload(
      makeClient(send),
      feed.id,
      '{"title":"hello"}',
      { title: 'hello' },
      headers(),
    );

    expect(result).toEqual({ ok: false, status: 502, reason: 'Webhook-Zustellung fehlgeschlagen.' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.idempotencyKey.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('behaelt den Replay-Claim, wenn Discord erfolgreich war und nur die DB-Finalisierung scheitert', async () => {
    const send = jest.fn().mockResolvedValue({ id: 'message-1' });
    prismaMock.$transaction.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await deliverWebhookPayload(
      makeClient(send),
      feed.id,
      '{"title":"hello"}',
      { title: 'hello' },
      headers(),
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.idempotencyKey.delete).not.toHaveBeenCalled();
  });

  it('blockiert einen bereits geclaimten Replay vor jeder Discord-Zustellung', async () => {
    const send = jest.fn().mockResolvedValue({ id: 'message-1' });
    const duplicate = new Error('unique constraint') as Error & { code?: string };
    duplicate.code = 'P2002';
    prismaMock.idempotencyKey.create.mockRejectedValueOnce(duplicate);

    const result = await deliverWebhookPayload(
      makeClient(send),
      feed.id,
      '{"title":"hello"}',
      { title: 'hello' },
      headers(),
    );

    expect(result).toEqual({ ok: false, status: 409, reason: 'Webhook-Replay erkannt.' });
    expect(send).not.toHaveBeenCalled();
    expect(prismaMock.idempotencyKey.delete).not.toHaveBeenCalled();
  });
});
