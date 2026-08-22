import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/legacy-deps-inflight-glob-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string; status: string }>;
  residual: string[];
};
const pkg = JSON.parse(r('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('Stage 55 inflight/glob legacy deps', () => {
  it('documents stage and residual honesty for Jest transitive inflight', () => {
    expect(m.stage).toBe(55);
    expect(m.residual.join(' ')).toMatch(/jest/i);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['prod-no-direct-inflight', 'jest-inflight-dev-residual']),
    );
    expect(pkg.dependencies?.inflight).toBeUndefined();
    expect(pkg.dependencies?.glob).toBeUndefined();
  });

  it('production omit=dev tree does not require inflight', () => {
    // npm ls --omit=dev inflight should exit non-zero / empty when not found
    let code = 0;
    let out = '';
    try {
      out = execSync('npm ls inflight --omit=dev --json', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: unknown) {
      code = (e as { status?: number }).status ?? 1;
      out = String((e as { stdout?: string }).stdout || '');
    }
    // Either empty dependencies or explicit missing
    const parsed = out ? JSON.parse(out) : {};
    const hasInflight =
      JSON.stringify(parsed).includes('"inflight"') &&
      /"version":\s*"1\./.test(JSON.stringify(parsed));
    expect(hasInflight).toBe(false);
    // non-zero exit from npm ls when missing is acceptable
    expect([0, 1]).toContain(code === undefined ? 0 : code);
  });

  it('forbids skip/only', () => {
    const self = r('tests/security/legacyDepsInflightGlobArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
