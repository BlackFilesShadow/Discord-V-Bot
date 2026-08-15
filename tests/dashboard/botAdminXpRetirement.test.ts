process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { botAdminXpRetirementRouter } from '../../src/dashboard/routes/v2/botAdminXpRetirement';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/bot-admin', botAdminXpRetirementRouter);
  return instance;
}

describe('retired BotAdmin XP surface', () => {
  it('failt alte GET- und Mutation-Pfade geschlossen mit 410', async () => {
    for (const response of [
      await request(app()).get('/bot-admin/xp'),
      await request(app()).patch('/bot-admin/xp').send({ messageXpMin: 1 }),
      await request(app()).post('/bot-admin/xp/level-roles').send({ level: 1, roleId: '123456789012345678' }),
      await request(app()).delete('/bot-admin/xp/level-roles/legacy').send({ guildId: '123456789012345678' }),
    ]) {
      expect(response.status).toBe(410);
      expect(response.body).toMatchObject({ code: 'BOTADMIN_XP_RETIRED', replacement: '/dev/command-center' });
    }
  });

  it('mountet den Retirement-Guard vor allen Legacy-BotAdmin-Safety-/Business-Routern', () => {
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'src/dashboard/routes/v2.ts'), 'utf8');
    const mount = routes.indexOf("v2Router.use('/bot-admin', requireGlobalBotAdminIdentity, botAdminXpRetirementRouter, botAdminDangerSafetyRouter, botAdminSafeValidationRouter, botAdminSafePackageDeleteRouter, guardBotAdminGuildReferences, botAdminRouter);");
    expect(mount).toBeGreaterThanOrEqual(0);
  });

  it('enthaelt die BotAdmin-Oberflaeche keine XP-Navigation oder XP-API-Aufrufe mehr', () => {
    const ui = fs.readFileSync(path.resolve(process.cwd(), 'dashboard-ui/src/components/BotAdminTab.tsx'), 'utf8');
    expect(ui).not.toContain("'xp'");
    expect(ui).not.toContain('XP-System');
    expect(ui).not.toContain('function XpSection');
    expect(ui).not.toContain("g('/xp')");
    expect(ui).toContain('XP-Konfiguration ist DEV-only');
  });
});
