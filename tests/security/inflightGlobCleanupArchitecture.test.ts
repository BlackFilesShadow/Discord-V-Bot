import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/inflight-glob-cleanup-matrix.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

describe('Stage 55 inflight glob cleanup', () => {
  it('avoids blind overrides', () => {
    expect(m.stage).toBe(55);
    expect(m.decision).toMatch(/No blind npm overrides/);
    if (pkg.overrides) {
      expect(JSON.stringify(pkg.overrides)).not.toMatch(/"inflight"\s*:\s*"npms/);
    }
  });
});
