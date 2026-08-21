import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/load-test-matrix.json'), 'utf8'));

describe('Stage 50 load test', () => {
  it('skips cleanly without BASE_URL', () => {
    expect(m.stage).toBe(50);
    const raw = execFileSync(process.execPath, ['scripts/load-test-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, LOAD_TEST_BASE_URL: '' },
    });
    const data = JSON.parse(raw);
    expect(data.stage).toBe(50);
    expect(data.skipped).toBe(true);
  });
});
