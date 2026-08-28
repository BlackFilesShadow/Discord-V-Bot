import fs from 'fs';
import path from 'path';

describe('Bot-Admin DEV frontend bridge architecture', () => {
  const sessionFile = fs.readFileSync(
    path.join(process.cwd(), 'dashboard-ui/src/lib/botAdminSession.tsx'),
    'utf8',
  );
  const panelFile = fs.readFileSync(
    path.join(process.cwd(), 'dashboard-ui/src/components/BotAdminLoginPanel.tsx'),
    'utf8',
  );

  it('uses the existing DEV status only as fallback when no BotAdminSession is active', () => {
    expect(sessionFile).toContain("'/api/v2/bot-admin/status'");
    expect(sessionFile).toContain("'/api/v2/dev/status'");
    expect(sessionFile).toContain("applyStatus({ active: true, expiresAt: dev.expiresAt ?? null }, 'dev')");
  });

  it('tracks the access source so DEV-backed access is not confused with a BotAdminSession', () => {
    expect(sessionFile).toContain("export type BotAdminAccessSource = 'bot-admin' | 'dev' | null");
    expect(sessionFile).toContain("if (source === 'dev')");
    expect(panelFile).toContain("const viaDev = source === 'dev'");
    expect(panelFile).toContain("{viaDev ? 'ADMIN · DEV' : 'ADMIN'}");
  });

  it('does not expose the BotAdminSession logout control for DEV-backed access', () => {
    expect(panelFile).toContain('{!viaDev && (');
    expect(panelFile).toContain('Bot-Admin-Session beenden');
  });
});
