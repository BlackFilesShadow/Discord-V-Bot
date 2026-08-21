import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/runtime-baseline-ii-matrix.json'), 'utf8'));

describe('Stage 47 runtime baseline II', () => {
  it('documents stage and runs structural harness', () => {
    expect(m.stage).toBe(47);
    const raw = execFileSync(process.execPath, ['scripts/runtime-baseline-ii-check.mjs'], { encoding: 'utf8' });
    const data = JSON.parse(raw);
    expect(data.prismaSingleton).toBe(true);
    expect(data.redisConfiguredInEnvExample).toBe(true);
    expect(data.nitradoJobModel).toBe(true);
  });
});
