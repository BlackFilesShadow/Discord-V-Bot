import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/soak-test-matrix.json'), 'utf8'));

describe('Stage 51 soak test', () => {
  it('pins the completed two-hour exact-SHA evidence without claiming a live Discord run', () => {
    expect(m).toMatchObject({
      stage: 51,
      status: 'VERIFIED',
      residual: [],
      measurements: {
        durationMs: 7_200_000,
        requests: 1_062_972,
        failures: 0,
        allGatesPassed: true,
      },
    });
    expect(m.contracts.exactSha).toBe('b540786f857f16f8ec422288f020b30328034278');
    expect(m.contracts.workflowRuns).toMatch(/32622474368.*32628364174/);
    expect(m.contracts.honesty).toMatch(/isolated CI/i);

    const workflow = fs.readFileSync(path.resolve('.github/workflows/stage51-soak.yml'), 'utf8');
    expect(workflow).toContain("STAGE51_DURATION_MS: '7200000'");
    expect(workflow).toContain("STAGE51_REQUIRE_LIVE: '1'");
    expect(workflow).toContain('scripts/full-stack-soak-51.ts');
  });

  it('runs short soak harness', () => {
    expect(m.stage).toBe(51);
    const raw = execFileSync(process.execPath, ['scripts/soak-test-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, SOAK_LOOPS: '2', SOAK_SAMPLE_MS: '50', WRITE_PERF_ARTIFACTS: '0' },
      timeout: 30_000,
    });
    const data = JSON.parse(raw);
    expect(data.stage).toBe(51);
    expect(data.loops).toBe(2);
    expect(Number.isFinite(data.deltaMb)).toBe(true);
  });
});
