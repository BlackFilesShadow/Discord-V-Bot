/**
 * Stage 50 — real in-process HTTP load against a tiny Node server.
 * No external dashboard required. Writes SHA-bound JSON when WRITE_PERF_ARTIFACTS!=0.
 *
 * Env:
 *   LOAD_DURATION_MS (default 1500)
 *   LOAD_CONCURRENCY (default 25)
 *   LOAD_REQUESTS_PER_WORKER (default 40)
 *   WRITE_PERF_ARTIFACTS=0 to skip disk
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cpus } from 'node:os';

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

const durationMs = Number(process.env.LOAD_DURATION_MS ?? 1500);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 25);
const rpw = Number(process.env.LOAD_REQUESTS_PER_WORKER ?? 40);

let hits = 0;
let authDenied = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url?.startsWith('/health?')) {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits, uptime: process.uptime() }));
    return;
  }
  if (req.url?.startsWith('/api/')) {
    authDenied++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
    return;
  }
  res.writeHead(404);
  res.end('nf');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const stats = [];
const cpu0 = process.cpuUsage();
const mem0 = process.memoryUsage();
const t0 = performance.now();
const deadline = t0 + durationMs;

async function worker(id) {
  let n = 0;
  while (performance.now() < deadline && n < rpw) {
    const pathName = n % 5 === 0 ? '/api/v2/dev/status/system' : '/health';
    const start = performance.now();
    let status = 0;
    let ok = false;
    try {
      const r = await fetch(`${base}${pathName}`);
      status = r.status;
      ok = pathName === '/health' ? r.ok : r.status === 401;
      await r.text().catch(() => '');
    } catch {
      status = 0;
      ok = false;
    }
    stats.push({ ms: performance.now() - start, status, ok, path: pathName, w: id });
    n++;
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const elapsed = (performance.now() - t0) / 1000;
const cpu = process.cpuUsage(cpu0);
const mem1 = process.memoryUsage();
server.close();

const lat = stats.map((s) => s.ms).sort((a, b) => a - b);
const okN = stats.filter((s) => s.ok).length;
const errN = stats.length - okN;
const codes = {};
for (const s of stats) codes[s.status] = (codes[s.status] || 0) + 1;

const envelope = {
  stage: 50,
  kind: 'in-process-http-load',
  exactSha: gitSha(),
  capturedAt: new Date().toISOString(),
  config: { durationMs, concurrency, requestsPerWorkerCap: rpw, base },
  host: { node: process.version, platform: process.platform, cpuCount: cpus().length },
  results: {
    requests: stats.length,
    ok: okN,
    errors: errN,
    errorRatio: stats.length ? +(errN / stats.length).toFixed(4) : 1,
    rps: +(stats.length / elapsed).toFixed(2),
    elapsedSec: +elapsed.toFixed(3),
    latencyMs: {
      p50: +quantile(lat, 0.5).toFixed(3),
      p95: +quantile(lat, 0.95).toFixed(3),
      p99: +quantile(lat, 0.99).toFixed(3),
      max: +(lat[lat.length - 1] || 0).toFixed(3),
    },
    statusCodes: codes,
    serverHitsHealth: hits,
    serverAuthDenied: authDenied,
  },
  resources: {
    cpuUserMs: +(cpu.user / 1000).toFixed(2),
    cpuSystemMs: +(cpu.system / 1000).toFixed(2),
    rssMbDelta: +((mem1.rss - mem0.rss) / 1024 / 1024).toFixed(2),
    heapUsedMbDelta: +((mem1.heapUsed - mem0.heapUsed) / 1024 / 1024).toFixed(2),
    heapUsedMbEnd: +(mem1.heapUsed / 1024 / 1024).toFixed(2),
  },
  residual: [
    'Synthetic health/auth endpoints only — not full dashboard+DB stack',
    'Auth path asserts 401 fail-closed under load (no cookie)',
  ],
};

console.log(JSON.stringify(envelope, null, 2));

if (process.env.WRITE_PERF_ARTIFACTS !== '0') {
  const sha = envelope.exactSha;
  const dir = path.join(process.cwd(), 'docs/audit/performance', sha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '50-load.json'), JSON.stringify(envelope, null, 2) + '\n');
}

// Fail if error ratio > 1% (unexpected transport failures)
if (envelope.results.errorRatio > 0.01) process.exit(2);
