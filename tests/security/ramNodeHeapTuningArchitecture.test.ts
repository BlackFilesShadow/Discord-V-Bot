import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/ram-node-heap-tuning-matrix.json'), 'utf8'));
const docker = fs.readFileSync(path.resolve('Dockerfile'), 'utf8');

describe('Stage 52 RAM node heap tuning', () => {
  it('does not introduce undocumented huge heap flags', () => {
    expect(m.stage).toBe(52);
    expect(m.decision).toMatch(/No production heap flag change/);
    // Allow modest flags if present, but fail if absurd multi-GB without comment marker STAGE52_HEAP
    const match = docker.match(/max-old-space-size=(\d+)/);
    if (match) {
      const mb = Number(match[1]);
      if (mb >= 4096) {
        expect(docker).toContain('STAGE52_HEAP');
      }
    }
  });
});
