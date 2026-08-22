import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/gesamtaudit-1-code-architecture-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string }>;
};
const v2 = r('src/dashboard/routes/v2.ts');
const secDir = path.resolve('tests/security');
const arch = fs.readdirSync(secDir).filter((f) => /Architecture\.test\.ts$/.test(f));

describe('Stage 60 gesamtaudit 1 code architecture', () => {
  it('keeps v2 auth mount and architecture gate corpus', () => {
    expect(m.stage).toBe(60);
    expect(v2).toContain('v2Router.use(requireAuth)');
    expect(v2).toContain('v2Router.use(idempotency)');
    expect(arch.length).toBeGreaterThanOrEqual(40);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['arch-gate-corpus-ge-40', 'v2-requireAuth-idempotency']),
    );
    expect(r('tests/security/gesamtaudit1CodeArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('pins AI toolRuntime security path and scan harness', () => {
    const tr = r('src/modules/ai/toolRuntime.ts');
    expect(tr).toMatch(/guildId|AuthZ|authorization|idempoten|scope/i);
    expect(fs.existsSync(path.resolve('scripts/gesamtaudit-scan.mjs'))).toBe(true);
  });

  it('gesamtaudit-scan exits 0 with stages 60-62 envelope', () => {
    const raw = execFileSync(process.execPath, ['scripts/gesamtaudit-scan.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, WRITE_PERF_ARTIFACTS: '0' },
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const data = JSON.parse(raw.slice(start, end + 1)) as {
      stages: number[];
      findings: unknown[];
      inventory: { architectureTests: number };
    };
    expect(data.stages).toEqual([60, 61, 62]);
    expect(data.findings).toEqual([]);
    expect(data.inventory.architectureTests).toBeGreaterThanOrEqual(40);
  });
});
