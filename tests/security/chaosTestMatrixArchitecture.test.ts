import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/chaos-test-matrix.json'), 'utf8'));
const idemp = fs.readFileSync(path.resolve('src/dashboard/middleware/idempotency.ts'), 'utf8');

describe('Stage 59 chaos test matrix', () => {
  it('documents faults and keeps idempotency fail-closed', () => {
    expect(m.stage).toBe(59);
    expect(idemp).toContain('IDEMPOTENCY_STORE_UNAVAILABLE');
    const raw = execFileSync(process.execPath, ['scripts/chaos-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, WRITE_PERF_ARTIFACTS: '0' },
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const data = JSON.parse(raw.slice(start, end + 1)) as { faults: string[] };
    expect(data.faults.length).toBeGreaterThanOrEqual(5);
  });
});
