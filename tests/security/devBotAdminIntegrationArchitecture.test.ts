import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('DEV integrated Bot-Admin workspace architecture', () => {
  test('exposes the Bot-Admin workspace as a DEV child route and sidebar entry', () => {
    const app = read('dashboard-ui/src/App.tsx');
    const dev = read('dashboard-ui/src/pages/Dev.tsx');

    expect(app).toContain("const DevBotAdmin = lazyPage(() => import('./pages/BotAdmin').then(({ DevBotAdminPage }) => ({ default: DevBotAdminPage })))");
    expect(app).toContain('<Route path="bot-admin" element={<DevBotAdmin />} />');
    expect(dev).toContain('const botAdminActive = loc.pathname === \'/dev/bot-admin\';');
    expect(dev).toContain('<NavLink to="/dev/bot-admin"');
    expect(dev).toContain('<span>Bot-Admin</span>');
  });

  test('reuses the existing Bot-Admin business UI without requiring a second frontend session gate', () => {
    const page = read('dashboard-ui/src/pages/BotAdmin.tsx');

    expect(page).toContain('export function BotAdminWorkspace({ isDeveloperOwner }: BotAdminWorkspaceProps)');
    expect(page).toContain('export function DevBotAdminPage()');
    expect(page).toContain('return <BotAdminWorkspace isDeveloperOwner />;');
    expect(page).toContain('<BotAdminTab showFeedback={isDeveloperOwner} />');
    expect(page).toContain('<BotAdminOwnerTickets />');
    expect(page).toContain('<BotAdminKnowledgeScoped />');
    expect(page).toContain('<BotAdminCommandCenter showFeedback={isDeveloperOwner} />');
  });

  test('keeps server-side Bot-Admin authorization and its DEV-session fallback intact', () => {
    const auth = read('src/dashboard/middleware/auth.ts');

    expect(auth).toContain('export async function requireBotAdmin');
    expect(auth).toContain("if (req.auth.role === 'DEVELOPER') {");
    expect(auth).toContain('await requireDev(req, res, next);');
    expect(auth).toContain("code: 'BOTADMIN_LOGIN_REQUIRED'");
  });
});
