import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const v2Source = read('src/dashboard/routes/v2.ts');
const contractSource = read('src/dashboard/routes/v2/botAdminLegacyContract.ts');
const knowledgeSource = read('src/dashboard/routes/v2/botAdminKnowledge.ts');
const mainSource = read('dashboard-ui/src/main.tsx');
const mobileCss = read('dashboard-ui/src/botAdmin.mobile.css');

describe('Dashboard-1X Bot-Admin contract architecture', () => {
  test('legacy Bot-Admin router stays behind the strict contract adapter', () => {
    expect(v2Source).toContain("import { botAdminLegacyContractRouter } from './v2/botAdminLegacyContract';");
    expect(v2Source).toMatch(
      /guardBotAdminGuildReferences,\s*botAdminLegacyContractRouter,\s*botAdminRouter/,
    );
  });

  test('strict adapter protects pagination, filters and dangerous coercion points', () => {
    expect(contractSource).toContain("STRICT_POSITIVE_INT_RE = /^[1-9]\\d*$/");
    expect(contractSource).toContain("botAdminLegacyContractRouter.get('/appeals', requireBotAdmin, validateBotAdminPagination, appealStatus)");
    expect(contractSource).toContain("botAdminLegacyContractRouter.get('/feedback', requireBotAdmin, validateBotAdminPagination, feedbackStatus)");
    expect(contractSource).toContain("botAdminLegacyContractRouter.get('/tickets', requireBotAdmin, validateBotAdminPagination, ticketStatus)");
    expect(contractSource).toContain("botAdminLegacyContractRouter.post('/upload/toggle', requireBotAdmin, requiredBooleanBody('enable'))");
    expect(contractSource).toContain("botAdminLegacyContractRouter.post('/users/:id/toggle-upload', requireBotAdmin, requiredBooleanBody('enable'))");
    expect(contractSource).toContain("botAdminLegacyContractRouter.post('/users/:id/reset-password', requireBotAdmin, validateResetPasswordExpiry)");
  });

  test('canonical knowledge toggle rejects malformed booleans instead of coercing to false', () => {
    expect(knowledgeSource).toContain("typeof req.body.active !== 'boolean'");
    expect(knowledgeSource).toContain("const active = req.body.active;");
    expect(knowledgeSource).not.toContain("const active = req.body?.active === true;");
  });

  test('Bot-Admin mobile navigation has a dedicated 44px touch-target contract', () => {
    expect(mainSource).toContain("import './botAdmin.mobile.css';");
    expect(mobileCss).toContain("nav[aria-label='Bot-Admin-Bereiche'] > button");
    expect(mobileCss).toContain('min-height: 44px');
  });
});
