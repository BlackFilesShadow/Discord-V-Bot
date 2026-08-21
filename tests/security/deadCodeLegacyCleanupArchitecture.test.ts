import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/dead-code-legacy-cleanup-matrix.json'), 'utf8'));

describe('Stage 57 dead code legacy cleanup', () => {
  it('records conservative cleanup policy', () => {
    expect(m.stage).toBe(57);
    expect(m.decision).toMatch(/No mass deletion/);
  });
});
