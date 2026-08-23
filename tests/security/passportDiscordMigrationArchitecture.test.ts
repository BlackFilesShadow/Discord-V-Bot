import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/passport-discord-migration-matrix.json')) as {
  stage: number;
  schemaVersion: number;
  basedOnMainSha: string;
  status: string;
  contracts: Record<string, string>;
  cases: Array<{ id: string; status: string }>;
};
const pkg = JSON.parse(r('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const auth = r('src/dashboard/routes/auth.ts');

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('Stage 54 passport-discord migration (removed unused)', () => {
  it('binds the revalidation to current main and keeps passport packages absent', () => {
    expect(m.stage).toBe(54);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(m.basedOnMainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.status).toBe('REMOVED_UNUSED_DEPS_REVALIDATED');
    expect(pkg.dependencies?.passport).toBeUndefined();
    expect(pkg.dependencies?.['passport-discord']).toBeUndefined();
    expect(pkg.devDependencies?.['@types/passport']).toBeUndefined();
    expect(pkg.devDependencies?.['@types/passport-discord']).toBeUndefined();
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'passport-discord-removed',
        'passport-removed',
        'custom-oauth-pkce-canonical',
        'no-src-passport-import',
        'package-tree-passport-empty',
        'oauth-session-e2e-regression',
      ]),
    );
  });

  it('canonical OAuth remains custom PKCE routes without passport imports', () => {
    expect(auth).toContain("authRouter.get('/login'");
    expect(auth).toContain("authRouter.get('/callback'");
    expect(auth).toContain("authRouter.get('/logout'");
    expect(auth).toContain('generatePKCE');
    expect(auth).not.toMatch(/passport-discord|from ['\"]passport['\"]|require\(['\"]passport/);
    const srcFiles = walkTs(path.resolve('src'));
    for (const f of srcFiles) {
      const body = fs.readFileSync(f, 'utf8');
      expect(body).not.toMatch(/from ['\"]passport-discord['\"]|from ['\"]passport['\"]/);
      expect(body).not.toMatch(/require\(['\"]passport-discord['\"]\)|require\(['\"]passport['\"]\)/);
    }
  });

  it('npm ls shows passport packages empty and preserves the one-cycle regression contract', () => {
    let out = '';
    try {
      out = execSync('npm ls passport passport-discord --json', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: unknown) {
      out = String((e as { stdout?: string }).stdout || '');
    }
    expect(out).not.toMatch(/\"passport-discord\"\s*:\s*\{/);
    expect(out).not.toMatch(/passport-discord@0\.1/);
    expect(m.contracts.shaRule).toMatch(/one complete CI\/CD \+ Verification 2 \+ Playwright cycle/);
    const self = r('tests/security/passportDiscordMigrationArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
