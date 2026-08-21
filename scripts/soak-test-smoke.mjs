/** Stage 51 — short soak via repeated runtime baseline samples. */
import { spawnSync } from 'node:child_process';

const loops = Number(process.env.SOAK_LOOPS ?? 3);
const samples = [];
for (let i = 0; i < loops; i++) {
  const r = spawnSync(process.execPath, ['scripts/runtime-baseline-i.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, RUNTIME_BASELINE_MS: process.env.SOAK_SAMPLE_MS ?? '100' },
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  samples.push(JSON.parse(r.stdout));
}
const heaps = samples.map((s) => s.heapUsedMb);
const max = Math.max(...heaps);
const min = Math.min(...heaps);
console.log(JSON.stringify({ stage: 51, loops, minHeapMb: min, maxHeapMb: max, deltaMb: +(max - min).toFixed(2), samples }, null, 2));
