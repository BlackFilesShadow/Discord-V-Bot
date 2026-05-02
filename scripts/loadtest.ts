#!/usr/bin/env -S npx ts-node
/**
 * Lasttest-Tool ohne externe Deps. Schickt N concurrent Requests gegen ein
 * laufendes Dashboard (default http://localhost:3000) und misst:
 *
 *   - Throughput (requests/sec)
 *   - Latenz p50/p95/p99/max
 *   - Status-Verteilung
 *   - Fehlerquote
 *
 * Aufruf:
 *   npm run loadtest -- --url=http://localhost:3000/health --duration=30 --concurrency=50
 *
 * Defaults sind konservativ (10s, 20 parallel) damit man's lokal gefahrlos
 * laufen lassen kann. Cookie-Header durchreichen via --cookie="connect.sid=...".
 */
import { performance } from 'node:perf_hooks';

interface Options {
  url: string;
  duration: number;       // Sekunden
  concurrency: number;
  cookie?: string;
  method: string;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (k: string, d?: string) =>
    argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
  return {
    url: get('url', 'http://localhost:3000/health')!,
    duration: parseInt(get('duration', '10')!, 10),
    concurrency: parseInt(get('concurrency', '20')!, 10),
    cookie: get('cookie'),
    method: (get('method', 'GET')!).toUpperCase(),
  };
}

interface Stat {
  ms: number;
  status: number;
  ok: boolean;
}

async function worker(opts: Options, deadline: number, out: Stat[]): Promise<void> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.cookie) headers.Cookie = opts.cookie;
  while (performance.now() < deadline) {
    const t0 = performance.now();
    let status = 0; let ok = false;
    try {
      const r = await fetch(opts.url, { method: opts.method, headers });
      status = r.status;
      ok = r.ok;
      // Body lesen, sonst keep-alive blockiert
      await r.text().catch(() => '');
    } catch {
      status = 0; ok = false;
    }
    out.push({ ms: performance.now() - t0, status, ok });
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(`Lasttest: ${opts.method} ${opts.url}`);
  console.log(`Concurrency=${opts.concurrency}  Duration=${opts.duration}s\n`);

  const stats: Stat[] = [];
  const deadline = performance.now() + opts.duration * 1000;
  const t0 = performance.now();

  await Promise.all(
    Array.from({ length: opts.concurrency }, () => worker(opts, deadline, stats)),
  );

  const elapsed = (performance.now() - t0) / 1000;
  const total = stats.length;
  const ok = stats.filter(s => s.ok).length;
  const errors = total - ok;
  const latencies = stats.map(s => s.ms).sort((a, b) => a - b);
  const codes = new Map<number, number>();
  for (const s of stats) codes.set(s.status, (codes.get(s.status) ?? 0) + 1);

  console.log(`Requests:      ${total}`);
  console.log(`Throughput:    ${(total / elapsed).toFixed(1)} req/s`);
  console.log(`Erfolg:        ${ok} (${((ok / total) * 100).toFixed(2)}%)`);
  console.log(`Fehler:        ${errors} (${((errors / total) * 100).toFixed(2)}%)`);
  console.log(`Latenz p50:    ${quantile(latencies, 0.5).toFixed(1)} ms`);
  console.log(`Latenz p95:    ${quantile(latencies, 0.95).toFixed(1)} ms`);
  console.log(`Latenz p99:    ${quantile(latencies, 0.99).toFixed(1)} ms`);
  console.log(`Latenz max:    ${latencies[latencies.length - 1]?.toFixed(1)} ms`);
  console.log(`Status-Codes:  ${[...codes.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // Exit-Code: !=0 wenn Fehlerquote > 1%
  const errRatio = errors / total;
  if (errRatio > 0.01) {
    console.error(`\nFEHLERQUOTE ${(errRatio * 100).toFixed(2)}% > 1%`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
