import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/runtime-baseline-i-matrix.json')) as { stage: number; metrics: string[] };

describe('Stage 46 runtime baseline I', () => {
  it('documents metrics inventory', () => {
    expect(m.stage).toBe(46);
    expect(m.metrics).toEqual(expect.arrayContaining(['rssMb', 'heapUsedMb', 'eventLoopDelayMsP99']));
    expect(fs.existsSync(path.resolve(process.cwd(), 'scripts/runtime-baseline-i.mjs'))).toBe(true);
  });

  it('runs idle harness and returns finite metrics', () => {
    const raw = execFileSync(process.execPath, ['scripts/runtime-baseline-i.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, RUNTIME_BASELINE_MS: '200' },
      timeout: 15_000,
    });
    const data = JSON.parse(raw) as Record<string, number>;
    expect(data.stage).toBe(46);
    expect(Number.isFinite(data.rssMb)).toBe(true);
    expect(data.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(data.heapUsedMb)).toBe(true);
    expect(Number.isFinite(data.eventLoopDelayMsP50)).toBe(true);
    expect(Number.isFinite(data.cpuUserMs)).toBe(true);
  });
});
