/**
 * Tests für die Dashboard-API-Routes (Sektion 7, 12).
 * Prüft Auth-Middleware, Rate-Limiting, API-Endpunkte.
 */

// Mock Prisma
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    package: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    securityEvent: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    giveaway: { findMany: jest.fn().mockResolvedValue([]) },
    moderationCase: { findMany: jest.fn().mockResolvedValue([]) },
    levelData: { findMany: jest.fn().mockResolvedValue([]) },
    botConfig: { findMany: jest.fn().mockResolvedValue([]) },
    session: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));

jest.mock('../../src/modules/logging/analyticsManager', () => ({
  getAnalytics: jest.fn().mockResolvedValue({ users: 0, packages: 0, downloads: 0 }),
  checkAlerts: jest.fn().mockResolvedValue([]),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { apiRouter } from '../../src/dashboard/routes/api';

function createTestApp(sessionData?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true,
    })
  );

  // Session einfügen (simuliert Login)
  if (sessionData) {
    app.use((req, _res, next) => {
      Object.assign(req.session, sessionData);
      next();
    });
  }

  app.use('/api', apiRouter);
  return app;
}

describe('Dashboard API Routes (Sektion 7)', () => {
  describe('Auth-Middleware', () => {
    it('sollte unauthentifizierte Anfragen ablehnen (401)', async () => {
      const app = createTestApp();
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Nicht authentifiziert');
    });

    it('sollte 2FA-pending Anfragen ablehnen (403)', async () => {
      const app = createTestApp({ userId: 'test', requires2FA: true });
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('2FA');
    });

    it('sollte authentifizierte Anfragen durchlassen', async () => {
      const app = createTestApp({ userId: 'test-user-id' });
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/stats', () => {
    it('sollte Statistiken zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
    });
  });

  describe('GET /api/users', () => {
    it('sollte paginierte User zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/users?page=1&perPage=10');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
    });
  });

  describe('GET /api/packages', () => {
    it('sollte paginierte Pakete zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/packages?page=1');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('packages');
      expect(res.body).toHaveProperty('totalPages');
    });
  });

  describe('GET /api/audit-logs', () => {
    it('sollte Audit-Logs zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/audit-logs?days=7');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
    });
  });

  describe('GET /api/security-events', () => {
    it('sollte Security-Events zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/security-events');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('events');
    });
  });

  describe('GET /api/leaderboard', () => {
    it('sollte Leaderboard-Daten zurückgeben (mit guildId)', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/leaderboard?guildId=g1&limit=10');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('entries');
    });

    it('sollte 400 ohne guildId zurückgeben', async () => {
      const app = createTestApp({ userId: 'test' });
      const res = await request(app).get('/api/leaderboard?limit=10');
      expect(res.status).toBe(400);
    });
  });
});
