process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * F-004 Regression: Zwei parallele identische Requests mit demselben
 * X-Idempotency-Key duerfen den Handler NUR EINMAL ausfuehren. Der zweite
 * Aufruf erhaelt entweder das gecachte Ergebnis oder 409 (in Bearbeitung) —
 * niemals eine zweite Handler-Ausfuehrung (Doppelaktion).
 */

interface Row { hash: string; status?: string; responseBody?: unknown; responseStatus?: number | null; createdAt: Date; expiresAt: Date; [k: string]: unknown }
const store = new Map<string, Row>();

const prismaMock = {
  idempotencyKey: {
    // create ist der atomare Claim: PK-Kollision -> wirft (wie Postgres unique).
    create: jest.fn(async ({ data }: { data: Row }) => {
      if (store.has(data.hash)) {
        const err = new Error('Unique constraint failed on the fields: (`hash`)') as Error & { code?: string };
        err.code = 'P2002';
        throw err;
      }
      const row: Row = { ...data, createdAt: data.createdAt ?? new Date() };
      store.set(data.hash, row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }: { where: { hash: string } }) => {
      // kleine Latenz erzwingt echte Nebenlaeufigkeit zwischen den Requests
      await new Promise((r) => setTimeout(r, 5));
      const row = store.get(where.hash);
      return row ? { ...row, createdAt: new Date(row.createdAt), expiresAt: new Date(row.expiresAt) } : null;
    }),
    updateMany: jest.fn(async ({ where, data }: {
      where: { hash: string; status?: string; createdAt?: Date };
      data: Partial<Row>;
    }) => {
      // Beide Recovery-Requests sollen ihren alten Snapshot lesen koennen,
      // bevor einer den CAS gewinnt.
      await new Promise((r) => setTimeout(r, 5));
      const row = store.get(where.hash);
      if (!row) return { count: 0 };
      if (where.status !== undefined && row.status !== where.status) return { count: 0 };
      if (where.createdAt && row.createdAt.getTime() !== where.createdAt.getTime()) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    update: jest.fn(async ({ where, data }: { where: { hash: string }; data: Partial<Row> }) => {
      const r = store.get(where.hash);
      if (!r) throw new Error('not found');
      Object.assign(r, data);
      return r;
    }),
    delete: jest.fn(async ({ where }: { where: { hash: string } }) => {
      store.delete(where.hash);
      return null;
    }),
  },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { idempotency } from '../../src/dashboard/middleware/idempotency';

let handlerCalls = 0;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = { userId: 'user-1' };
    next();
  });
  app.post('/action', idempotency, (_req, res) => {
    handlerCalls += 1;
    res.status(200).json({ n: handlerCalls });
  });
  app.post('/fail', idempotency, (_req, res) => {
    handlerCalls += 1;
    res.status(500).json({ error: 'boom' });
  });
  return app;
}

const KEY = 'idem-key-123456';

function requestHash(path: string, body: unknown): string {
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body ?? '')).digest('hex');
  return crypto.createHash('sha256')
    .update(['user-1', 'POST', path, KEY, bodyHash].join(':'))
    .digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  handlerCalls = 0;
});

describe('F-004 — atomare Idempotenz', () => {
  it('DENY invalid X-Idempotency-Key length with 400 before claim create', async () => {
    const app = makeApp();
    const short = await request(app).post('/action').set('X-Idempotency-Key', 'short').send({ x: 1 });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/8\.\.128/);
    const long = await request(app).post('/action').set('X-Idempotency-Key', 'k'.repeat(129)).send({ x: 1 });
    expect(long.status).toBe(400);
    expect(handlerCalls).toBe(0);
    expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('isolates body mismatch under same key (different bodyHash => separate claims)', async () => {
    const app = makeApp();
    const a = await request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 });
    const b = await request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 2 });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(handlerCalls).toBe(2);
    expect(a.body.n).toBe(1);
    expect(b.body.n).toBe(2);
  });

  it('isolates route mismatch under same key (path in hash prevents cross-route replay)', async () => {
    const app = makeApp();
    app.post('/other', idempotency, (_req, res) => {
      handlerCalls += 1;
      res.status(200).json({ route: 'other', n: handlerCalls });
    });
    const first = await request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ n: 1 });
    const other = await request(app).post('/other').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ route: 'other', n: 2 });
    expect(handlerCalls).toBe(2);
  });

  it('fail-closes with 503 IDEMPOTENCY_STORE_UNAVAILABLE when claim lookup fails after PK collision', async () => {
    const app = makeApp();
    const body = { x: 1 };
    const hash = requestHash('/action', body);
    store.set(hash, {
      hash,
      status: 'PROCESSING',
      responseBody: null,
      responseStatus: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    prismaMock.idempotencyKey.findUnique.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/action').set('X-Idempotency-Key', KEY).send(body);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('IDEMPOTENCY_STORE_UNAVAILABLE');
    expect(handlerCalls).toBe(0);
  });

  it('passes through without key and never touches claim store', async () => {
    const app = makeApp();
    const res = await request(app).post('/action').send({ x: 1 });
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('fuehrt bei zwei parallelen identischen Requests den Handler nur einmal aus', async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 }),
      request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 }),
    ]);
    expect(handlerCalls).toBe(1);
    // Der Zweitrequest erhaelt entweder das gecachte Ergebnis (200) oder 409 —
    // entscheidend ist: der Handler lief exakt einmal (keine Doppelaktion).
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect(a.status === 200 || b.status === 200).toBe(true);
  });

  it('liefert bei erneutem Aufruf das gecachte Ergebnis ohne Handler-Rerun', async () => {
    const app = makeApp();
    const first = await request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(first.status).toBe(200);
    const second = await request(app).post('/action').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(handlerCalls).toBe(1);
  });

  it('gibt den Claim bei nicht-erfolgreicher Antwort frei (Retry moeglich)', async () => {
    const app = makeApp();
    const first = await request(app).post('/fail').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(first.status).toBe(500);
    // Claim wurde freigegeben -> erneuter Versuch laeuft wieder durch den Handler
    const retry = await request(app).post('/fail').set('X-Idempotency-Key', KEY).send({ x: 1 });
    expect(retry.status).toBe(500);
    expect(handlerCalls).toBe(2);
  });

  it('laesst bei zwei parallelen Recovery-Requests fuer einen stale PROCESSING-Claim nur einen Handler laufen', async () => {
    const body = { x: 1 };
    const hash = requestHash('/action', body);
    store.set(hash, {
      hash,
      status: 'PROCESSING',
      responseBody: null,
      responseStatus: null,
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const app = makeApp();
    const [a, b] = await Promise.all([
      request(app).post('/action').set('X-Idempotency-Key', KEY).send(body),
      request(app).post('/action').set('X-Idempotency-Key', KEY).send(body),
    ]);

    expect(handlerCalls).toBe(1);
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect(a.status === 200 || b.status === 200).toBe(true);
  });

  it('laesst bei zwei parallelen Recovery-Requests fuer einen abgelaufenen DONE-Claim nur einen Handler laufen', async () => {
    const body = { x: 1 };
    const hash = requestHash('/action', body);
    store.set(hash, {
      hash,
      status: 'DONE',
      responseBody: { n: 99 },
      responseStatus: 200,
      createdAt: new Date(Date.now() - 70 * 60 * 1000),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const app = makeApp();
    const [a, b] = await Promise.all([
      request(app).post('/action').set('X-Idempotency-Key', KEY).send(body),
      request(app).post('/action').set('X-Idempotency-Key', KEY).send(body),
    ]);

    expect(handlerCalls).toBe(1);
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect(a.status === 200 || b.status === 200).toBe(true);
  });
});
