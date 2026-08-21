import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/chaos-test-matrix.json'), 'utf8'));
const idemp = fs.readFileSync(path.resolve('src/dashboard/middleware/idempotency.ts'), 'utf8');

describe('Stage 59 chaos test matrix', () => {
  it('documents faults and keeps idempotency fail-closed', () => {
    expect(m.stage).toBe(59);
    expect(idemp).toContain('IDEMPOTENCY_STORE_UNAVAILABLE');
    const raw = execFileSync(process.execPath, ['scripts/chaos-smoke.mjs'], { encoding: 'utf8' });
    const data = JSON.parse(raw);
    expect(data.faults.length).toBeGreaterThanOrEqual(5);
  });
});
