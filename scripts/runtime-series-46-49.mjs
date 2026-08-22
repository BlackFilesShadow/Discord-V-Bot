import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { cpus, loadavg, freemem, totalmem } from 'node:os';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sampleCount = Math.max(5, Number(process.env.RUNTIME_SERIES_SAMPLES ?? 12));
const sampleMs = Math.max(50, Number(process.env.RUNTIME_SERIES_SAMPLE_MS ?? 750));
const settleMs = Math.max(0, Number(process.env.RUNTIME_SERIES_SETTLE_MS ?? 50));
const allocationMb = Math.max(1, Number(process.env.RUNTIME_SERIES_ALLOC_MB ?? 8));
const writeArtifacts = process.env.WRITE_PERF_ARTIFACTS !== '0';

function exactSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

function activeResources() {
  const byType = {};
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const type of process.getActiveResourcesInfo()) byType[type] = (byType[type] || 0) + 1;
  }
  return {
    count: Object.values(byType).reduce((sum, value) => sum + value, 0),
    byType,
    requests: process._getActiveRequests?.()?.length ?? 0,
    handlesLegacy: process._getActiveHandles?.()?.length ?? 0,
  };
}

function linearSlope(values) {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const gcEvents = [];
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEvents.push({ kind: entry.kind, durationMs: +entry.duration.toFixed(3) });
  }
});
try {
  gcObserver.observe({ entryTypes: ['gc'] });
} catch {
  // GC performance entries are optional on some Node builds.
}

async function oneSample(index) {
  if (global.gc) {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const before = process.memoryUsage();
  const cpu0 = process.cpuUsage();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const started = performance.now();

  // Allocate and release deterministic short-lived buffers to exercise recovery.
  let transient = Array.from({ length: allocationMb }, () => Buffer.alloc(1024 * 1024, index % 251));
  let spin = 0;
  const until = Date.now() + sampleMs;
  while (Date.now() < until) {
    spin = Math.sqrt(spin + 1) + 1;
    if (Math.floor(spin) % 5000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  transient = null;

  if (global.gc) {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  eventLoop.disable();
  const after = process.memoryUsage();
  const cpu = process.cpuUsage(cpu0);
  const toMb = (bytes) => +(bytes / 1024 / 1024).toFixed(2);
  const toMs = (ns) => +(Number(ns) / 1e6).toFixed(3);

  return {
    index,
    elapsedMs: +(performance.now() - started).toFixed(2),
    rssMb: toMb(after.rss),
    heapUsedMb: toMb(after.heapUsed),
    heapTotalMb: toMb(after.heapTotal),
    externalMb: toMb(after.external),
    arrayBuffersMb: toMb(after.arrayBuffers ?? 0),
    heapDeltaMb: toMb(after.heapUsed - before.heapUsed),
    cpuUserMs: +(cpu.user / 1000).toFixed(2),
    cpuSystemMs: +(cpu.system / 1000).toFixed(2),
    eventLoopDelayMsP50: toMs(eventLoop.percentile(50)),
    eventLoopDelayMsP99: toMs(eventLoop.percentile(99)),
    eventLoopDelayMsMax: toMs(eventLoop.max),
    resources: activeResources(),
  };
}

const sha = exactSha();
const capturedAt = new Date().toISOString();
const samples = [];
for (let i = 0; i < sampleCount; i += 1) samples.push(await oneSample(i));
await new Promise((resolve) => setImmediate(resolve));
gcObserver.disconnect();

const rss = samples.map((s) => s.rssMb);
const heap = samples.map((s) => s.heapUsedMb);
const handles = samples.map((s) => s.resources.count);
const listeners = samples.map(() => process.listenerCount('warning') + process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection'));
const gcDurations = gcEvents.map((event) => event.durationMs).sort((a, b) => a - b);
const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))] : null;

const result = {
  exactSha: sha,
  capturedAt,
  stage46: {
    sampleCount,
    sampleMs,
    cpuCount: cpus().length,
    loadAvg: loadavg(),
    osMemoryMb: { total: +(totalmem() / 1024 / 1024).toFixed(2), free: +(freemem() / 1024 / 1024).toFixed(2) },
    gc: {
      explicitGcAvailable: Boolean(global.gc),
      observedEvents: gcEvents.length,
      durationMsP50: percentile(gcDurations, 50),
      durationMsP99: percentile(gcDurations, 99),
      durationMsMax: gcDurations.length ? gcDurations.at(-1) : null,
    },
    samples,
  },
  stage49: {
    rssSlopeMbPerSample: +linearSlope(rss).toFixed(4),
    heapSlopeMbPerSample: +linearSlope(heap).toFixed(4),
    activeResourceSlopePerSample: +linearSlope(handles).toFixed(4),
    listenerSlopePerSample: +linearSlope(listeners).toFixed(4),
    first: samples[0],
    last: samples.at(-1),
    interpretation: 'Short deterministic allocation/recovery series. It can reveal monotonic retained growth, but does not replace the multi-hour Stage 51 soak.',
  },
};

console.log(JSON.stringify(result, null, 2));

if (writeArtifacts) {
  const dir = path.join(root, 'docs', 'audit', 'performance', sha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '46-49-runtime-series.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
