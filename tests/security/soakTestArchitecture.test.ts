import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/soak-test-matrix.json'), 'utf8'));

describe('Stage 51 soak test', () => {
  it('runs short soak harness', () => {
    expect(m.stage).toBe(51);
    const raw = execFileSync(process.execPath, ['scripts/soak-test-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, SOAK_LOOPS: '2', SOAK_SAMPLE_MS: '50' },
      timeout: 30_000,
    });
    const data = JSON.parse(raw);
    expect(data.stage).toBe(51);
    expect(data.loops).toBe(2);
    expect(Number.isFinite(data.deltaMb)).toBe(true);
  });
});
