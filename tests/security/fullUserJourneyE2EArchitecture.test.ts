import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/full-user-journey-e2e-matrix.json'), 'utf8'));

describe('Stage 58 full user journey E2E matrix', () => {
  it('inventories journey steps', () => {
    expect(m.stage).toBe(58);
    expect(m.steps.length).toBeGreaterThanOrEqual(8);
    expect(fs.existsSync(path.resolve('dashboard-ui/e2e'))).toBe(true);
  });
});
