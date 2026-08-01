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
      return store.get(where.hash) ?? null;
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

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  handlerCalls = 0;
});

describe('F-004 — atomare Idempotenz', () => {
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
});
