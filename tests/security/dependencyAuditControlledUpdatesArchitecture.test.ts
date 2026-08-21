import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/dependency-audit-controlled-updates-matrix.json'), 'utf8'));

describe('Stage 53 dependency audit controlled updates', () => {
  it('records no-blind-upgrade decision and keeps lockfile', () => {
    expect(m.stage).toBe(53);
    expect(m.decision).toMatch(/No bulk dependency upgrades/);
    expect(fs.existsSync(path.resolve('package-lock.json'))).toBe(true);
  });
});
