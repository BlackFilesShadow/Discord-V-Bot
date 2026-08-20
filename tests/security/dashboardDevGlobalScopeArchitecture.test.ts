import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Dashboard-2D DEV global-scope architecture', () => {
  const scopeGuard = read('src/dashboard/routes/v2/devDiagnosticScope.ts');
  const statusContract = read('src/dashboard/routes/v2/devDiagnosticsContract.ts');
  const stubsContract = read('src/dashboard/routes/v2/devDiagnosticsStubs.ts');

  test('uses one shared fail-closed scope guard for global diagnostics', () => {
    expect(scopeGuard).toContain('req.devSession?.scope.guildIdRestrict ?? null');
    expect(scopeGuard).toContain("code: 'DEV_SCOPE_RESTRICTED'");
    expect(statusContract).toContain("import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';");
    expect(stubsContract).toContain("import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';");
  });

  test('global status surfaces are guarded after requireDev and before their data reads', () => {
    expect(statusContract).toContain("for (const path of ['/system', '/ai-providers'] as const)");
    expect(statusContract).toMatch(/get\('\/database', requireDev, async \(req, res\) => \{\s*if \(rejectGlobalOnlyForRestrictedSession\(req, res\)\) return;/);
    expect(statusContract).toMatch(/get\('\/discord', requireDev, \(req, res\) => \{\s*if \(rejectGlobalOnlyForRestrictedSession\(req, res\)\) return;/);
  });

  test('global legacy stubs including heap snapshot are intercepted before fallthrough', () => {
    expect(stubsContract).toContain("path === '/server-stats'");
    expect(stubsContract).toContain("path === '/commands'");
    expect(stubsContract).toContain("path === '/debug'");
    expect(stubsContract).toContain("path.startsWith('/debug/')");
    expect(stubsContract).toContain('globalOnly && rejectGlobalOnlyForRestrictedSession(req, res)');
  });

  test('guild-scopeable sync diagnostics remain scoped rather than globally blocked', () => {
    expect(stubsContract).toContain("devDiagnosticsStubsRouter.get('/sync'");
    expect(stubsContract).toContain('const nitradoWhere = restrict ? { guildId: restrict } : undefined;');
    expect(stubsContract).toContain("const linkWhere = restrict ? { guildId: restrict, status: 'VERIFIED' as const }");
  });
});
