/**
 * Stage 51 — short soak: repeated memory samples under synthetic allocation + free.
 * Does not claim multi-hour production soak. Writes SHA artifacts when enabled.
 *
 * Env: SOAK_LOOPS (default 6), SOAK_SAMPLE_MS (default 30), WRITE_PERF_ARTIFACTS
 */
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

const loops = Number(process.env.SOAK_LOOPS ?? 6);
const sampleMs = Number(process.env.SOAK_SAMPLE_MS ?? 30);
const samples = [];
const t0 = performance.now();
let retained = [];

for (let i = 0; i < loops; i++) {
  // allocate and mostly drop to exercise GC; keep small ring buffer
  const chunk = Buffer.alloc(256 * 1024, i % 255);
  retained.push(chunk);
  if (retained.length > 8) retained = retained.slice(-4);
  const spinEnd = Date.now() + sampleMs;
  while (Date.now() < spinEnd) {
    Math.sqrt(Date.now() + i);
  }
  await new Promise((r) => setImmediate(r));
  const mem = process.memoryUsage();
  samples.push({
    i,
    rssMb: +(mem.rss / 1024 / 1024).toFixed(2),
    heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
    heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
    externalMb: +(mem.external / 1024 / 1024).toFixed(2),
    tMs: +(performance.now() - t0).toFixed(1),
  });
}

const heaps = samples.map((s) => s.heapUsedMb);
const min = Math.min(...heaps);
const max = Math.max(...heaps);
const first = heaps[0];
const last = heaps[heaps.length - 1];
const slope = loops > 1 ? (last - first) / (loops - 1) : 0;

const envelope = {
  stage: 51,
  kind: 'short-inprocess-soak',
  exactSha: gitSha(),
  capturedAt: new Date().toISOString(),
  loops,
  sampleMs,
  minHeapMb: min,
  maxHeapMb: max,
  deltaMb: +(max - min).toFixed(2),
  heapSlopePerLoopMb: +slope.toFixed(3),
  samples,
  residual: [
    'Short controlled soak only — not multi-hour production',
    'Rate-limit map bounds covered by Stage 49 unit tests under churn',
  ],
};

console.log(JSON.stringify(envelope, null, 2));

if (process.env.WRITE_PERF_ARTIFACTS !== '0') {
  const dir = path.join(process.cwd(), 'docs/audit/performance', envelope.exactSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '51-soak.json'), JSON.stringify(envelope, null, 2) + '\n');
}

if (!(loops >= 2 && samples.length === loops && Number.isFinite(max))) process.exit(2);
// runaway slope check (very loose for short windows)
if (slope > 50) process.exit(3);
