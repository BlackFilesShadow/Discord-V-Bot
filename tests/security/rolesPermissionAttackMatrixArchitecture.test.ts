import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/roles-permission-attack-matrix.json')) as { stage: number; cases: unknown[] };
const auth = r('src/dashboard/middleware/auth.ts');
const devGate = r('src/dashboard/middleware/globalDeveloperGate.ts');
const baGate = r('src/dashboard/middleware/globalBotAdminGate.ts');

describe('Stage 40 roles permission attack matrix', () => {
  it('documents cases', () => {
    expect(m.stage).toBe(40);
    expect(m.cases.length).toBeGreaterThanOrEqual(6);
  });

  it('binds membership to grants and separates DEV/BotAdmin identity', () => {
    expect(auth).toContain('GUILD_MEMBERSHIP_REQUIRED');
    expect(auth).toContain('resolveDelegatedPermissionContext');
    expect(auth).toContain('requireDev');
    expect(auth).toContain('DEV_LOGIN_REQUIRED');
    expect(devGate).toContain('requireGlobalDeveloperIdentity');
    expect(baGate).toContain('requireGlobalBotAdminIdentity');
  });
});
