import express from 'express';
import request from 'supertest';
import {
  guardBotAdminCommandCenterInput,
  guardDevCommandCenterInput,
} from '../../src/dashboard/middleware/commandCenterInputGuard';

function devApp() {
  const app = express();
  app.use(express.json());
  app.use('/dev', guardDevCommandCenterInput);
  app.get('/dev/security', (req, res) => res.json({ type: req.query.type ?? null }));
  app.post('/dev/export/logs', (req, res) => res.json({ category: req.body.category ?? null }));
  app.post('/dev/commands/reload', (req, res) => res.json({ scope: req.body.scope }));
  return app;
}

function botAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/bot-admin', guardBotAdminCommandCenterInput);
  app.get('/bot-admin/audit', (req, res) => res.json({ category: req.query.category ?? null }));
  return app;
}

describe('migrated command-center choice guards', () => {
  it('rejects an unknown SecurityEventType instead of forwarding it to Prisma', async () => {
    const response = await request(devApp()).get('/dev/security?type=NOT_A_REAL_EVENT');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Security-Event-Typ');
  });

  it('allows ALL and real security event types', async () => {
    expect((await request(devApp()).get('/dev/security?type=ALL')).status).toBe(200);
    expect((await request(devApp()).get('/dev/security?type=LOGIN_FAILURE')).status).toBe(200);
  });

  it('rejects an unknown audit category for POST-based DEV exports', async () => {
    const response = await request(devApp()).post('/dev/export/logs').send({ category: 'NOT_A_CATEGORY' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Audit-Kategorie');
  });

  it('allows a real audit category for POST-based DEV exports', async () => {
    const response = await request(devApp()).post('/dev/export/logs').send({ category: 'SECURITY' });
    expect(response.status).toBe(200);
    expect(response.body.category).toBe('SECURITY');
  });

  it('defaults a missing command reload scope to the safer deploy-only operation', async () => {
    const response = await request(devApp()).post('/dev/commands/reload').send({ reason: 'test' });
    expect(response.status).toBe(200);
    expect(response.body.scope).toBe('deploy');
  });

  it('rejects an unknown command reload scope instead of escalating to reload + deploy', async () => {
    const response = await request(devApp()).post('/dev/commands/reload').send({ scope: 'everything' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('deploy oder all');
  });

  it('rejects an unknown BotAdmin audit category', async () => {
    const response = await request(botAdminApp()).get('/bot-admin/audit?category=NOT_A_CATEGORY');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Audit-Kategorie');
  });

  it('allows a real BotAdmin audit category', async () => {
    const response = await request(botAdminApp()).get('/bot-admin/audit?category=SECURITY');
    expect(response.status).toBe(200);
  });
});
