import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/legacy-deps-inflight-glob-matrix.json')) as {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  decision: string;
  contracts: Record<string, string>;
  cases: Array<{ id: string; status: string }>;
  residual: string[];
};
const pkg = JSON.parse(r('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

describe('Stage 55 inflight/glob legacy deps', () => {
  it('binds the controlled residual decision to current main', () => {
    expect(m.stage).toBe(55);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(m.basedOnMainSha).toBe('f4752393fbfeb09dd8f12945d8a4a47a7b686c22');
    expect(m.decision).toMatch(/dev-only Jest 29 inflight@1\.0\.6\/glob@7 residual isolated/i);
    expect(m.contracts.shaRule).toMatch(/one complete CI\/CD \+ Verification 2 \+ Playwright cycle/i);
    expect(m.residual.join(' ')).toMatch(/jest/i);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'prod-no-direct-inflight',
        'prod-no-direct-glob7',
        'archiver-glob10-ok',
        'jest-inflight-dev-residual',
        'no-blind-override',
      ]),
    );
  });

  it('keeps inflight and legacy glob out of direct production dependencies', () => {
    expect(pkg.dependencies?.inflight).toBeUndefined();
    expect(pkg.dependencies?.glob).toBeUndefined();
    const overrides = JSON.stringify(pkg.overrides || {});
    expect(overrides).not.toMatch(/\"inflight\"\s*:/i);
  });

  it('production omit=dev tree does not require inflight', () => {
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
    const parsed = out ? JSON.parse(out) : {};
    const serialized = JSON.stringify(parsed);
    const hasInflight = serialized.includes('"inflight"') && /"version":\s*"1\./.test(serialized);
    expect(hasInflight).toBe(false);
    expect([0, 1]).toContain(code === undefined ? 0 : code);
  });

  it('forbids skip/only', () => {
    const self = r('tests/security/legacyDepsInflightGlobArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
