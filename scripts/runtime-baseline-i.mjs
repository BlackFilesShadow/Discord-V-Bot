/**
 * Stage 46 — Runtime Baseline I (idle Node process sample).
 * Usage: node scripts/runtime-baseline-i.mjs
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cpus } from 'node:os';

const sampleMs = Number(process.env.RUNTIME_BASELINE_MS ?? 1500);
const h = monitorEventLoopDelay({ resolution: 20 });
h.enable();
const cpu0 = process.cpuUsage();
const t0 = Date.now();

await new Promise((r) => setTimeout(r, sampleMs));

const cpu = process.cpuUsage(cpu0);
const mem = process.memoryUsage();
h.disable();
const toMs = (ns) => Number(ns) / 1e6;

const out = {
  stage: 46,
  sampleMs: Date.now() - t0,
  cpuCount: cpus().length,
  rssMb: +(mem.rss / 1024 / 1024).toFixed(2),
  heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
  heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
  externalMb: +(mem.external / 1024 / 1024).toFixed(2),
  eventLoopDelayMsP50: +toMs(h.percentile(50)).toFixed(3),
  eventLoopDelayMsP99: +toMs(h.percentile(99)).toFixed(3),
  eventLoopDelayMsMax: +toMs(h.max).toFixed(3),
  cpuUserMs: +(cpu.user / 1000).toFixed(2),
  cpuSystemMs: +(cpu.system / 1000).toFixed(2),
};

console.log(JSON.stringify(out, null, 2));
