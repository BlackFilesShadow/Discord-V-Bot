/**
 * Tests für den Legacy-API-Router (Sektion 7, 12).
 *
 * SICHERHEIT (P0): Der Router stellt nur noch /api/me bereit. Die frueheren
 * ungeschuetzten Admin-Endpoints wurden entfernt und muessen 404 liefern —
 * insbesondere auch fuer authentifizierte Sessions (kein Datenabfluss).
 */

// Mock Prisma
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        discordId: '123',
        username: 'tester',
        role: 'USER',
      }),
    },
  },
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

// Endpoints, die frueher existierten und jetzt ENTFERNT sind.
const REMOVED_ENDPOINTS = [
  '/api/stats',
  '/api/alerts',
  '/api/users',
  '/api/packages',
  '/api/audit-logs',
  '/api/security-events',
  '/api/giveaways',
  '/api/moderation',
  '/api/leaderboard',
  '/api/config',
];

describe('Dashboard API Routes (Sektion 7)', () => {
  describe('Auth-Middleware', () => {
    it('sollte unauthentifizierte Anfragen ablehnen (401)', async () => {
      const app = createTestApp();
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Nicht authentifiziert');
    });

    it('sollte 2FA-pending Anfragen ablehnen (403)', async () => {
      const app = createTestApp({ userId: 'test', requires2FA: true });
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('2FA');
    });
  });

  describe('GET /api/me', () => {
    it('liefert die eigenen minimalen Session-Daten', async () => {
      const app = createTestApp({ userId: 'test-user-id' });
      const res = await request(app).get('/api/me');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).toHaveProperty('username', 'tester');
      expect(res.body.user).toHaveProperty('role', 'USER');
      // Keine Tokens/sensitiven Felder im Response.
      expect(res.body.user).not.toHaveProperty('accessToken');
      expect(res.body.user).not.toHaveProperty('refreshToken');
    });
  });

  describe('Entfernte Legacy-Endpoints (P0 security regression)', () => {
    it.each(REMOVED_ENDPOINTS)(
      '%s liefert 404 fuer authentifizierte Sessions (kein Datenabfluss)',
      async (path) => {
        const app = createTestApp({ userId: 'test-user-id' });
        const res = await request(app).get(path);
        expect(res.status).toBe(404);
      }
    );

    it.each(REMOVED_ENDPOINTS)(
      '%s liefert 401 fuer unauthentifizierte Anfragen',
      async (path) => {
        const app = createTestApp();
        const res = await request(app).get(path);
        expect(res.status).toBe(401);
      }
    );
  });
});
