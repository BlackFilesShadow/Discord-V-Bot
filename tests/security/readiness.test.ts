process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * F-007 Regression: Readiness prueft DB UND Session-Store getrennt von der
 * Liveness. Ein defekter Session-Store -> 503 (not_ready).
 */
import express from 'express';
import request from 'supertest';
import { checkReadiness, readinessHandler } from '../../src/dashboard/health';

const ok = () => Promise.resolve(1);
const fail = () => Promise.reject(new Error('down'));

describe('F-007 — Readiness', () => {
  it('ready wenn DB und Session-Store ok sind', async () => {
    const r = await checkReadiness({ pingDb: ok, pingSessionStore: ok });
    expect(r).toEqual({ ready: true, checks: { database: 'ok', sessionStore: 'ok' } });
  });

  it('not ready wenn DB faellt', async () => {
    const r = await checkReadiness({ pingDb: fail, pingSessionStore: ok });
    expect(r.ready).toBe(false);
    expect(r.checks.database).toBe('fail');
  });

  it('not ready wenn Session-Store faellt', async () => {
    const r = await checkReadiness({ pingDb: ok, pingSessionStore: fail });
    expect(r.ready).toBe(false);
    expect(r.checks.sessionStore).toBe('fail');
  });

  it('Handler liefert 200 bei ready', async () => {
    const app = express();
    app.get('/health/ready', readinessHandler({ pingDb: ok, pingSessionStore: ok }));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('Handler liefert 503 bei defektem Session-Store', async () => {
    const app = express();
    app.get('/health/ready', readinessHandler({ pingDb: ok, pingSessionStore: fail }));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.sessionStore).toBe('fail');
  });
});
