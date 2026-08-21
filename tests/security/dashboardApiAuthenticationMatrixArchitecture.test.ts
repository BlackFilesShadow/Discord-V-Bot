import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const matrix = JSON.parse(read('docs/dashboard-api-authentication-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string; scenario: string; expected: string; evidence: string; status: string }>;
};
const authMw = read('src/dashboard/middleware/auth.ts');
const v2 = read('src/dashboard/routes/v2.ts');
const authRoutes = read('src/dashboard/routes/auth.ts');
const apiTest = read('tests/dashboard/api.test.ts');

describe('Stage 36 API authentication matrix', () => {
  it('inventories auth cases', () => {
    expect(matrix.stage).toBe(36);
    expect(matrix.cases.length).toBeGreaterThanOrEqual(8);
    for (const row of matrix.cases) {
      expect(row.id.trim()).not.toBe('');
      expect(row.scenario.trim()).not.toBe('');
      expect(row.expected.trim()).not.toBe('');
      expect(row.evidence.trim()).not.toBe('');
    }
  });

  it('mounts requireAuth on all v2 routes and rejects revoked DB sessions', () => {
    expect(v2).toContain('v2Router.use(requireAuth)');
    const mountIdx = v2.indexOf('v2Router.use(requireAuth)');
    const firstDomain = v2.indexOf("v2Router.use('/guilds'");
    expect(mountIdx).toBeGreaterThanOrEqual(0);
    expect(firstDomain).toBeGreaterThan(mountIdx);

    expect(authMw).toContain('export async function requireAuth');
    expect(authMw).toContain('SESSION_REVOKED');
    expect(authMw).toContain('SESSION_STORE_UNAVAILABLE');
    expect(authMw).toContain('prisma.session.findUnique');
    expect(authMw).toContain('!dbSession.isActive');
    expect(authMw).toContain('req.session.destroy');
  });

  it('keeps OAuth logout/status contracts and unauthenticated API tests', () => {
    expect(authRoutes).toContain("authRouter.get('/login'");
    expect(authRoutes).toContain("authRouter.post('/logout'");
    expect(authRoutes).toContain("authRouter.get('/status'");
    expect(authRoutes).toContain('isActive: false');
    expect(authRoutes).toContain('authenticated: false');
    expect(apiTest).toContain('unauthentifizierte Anfragen ablehnen (401)');
  });
});
