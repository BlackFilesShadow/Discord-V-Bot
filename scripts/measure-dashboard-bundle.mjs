/**
 * Stage 56 — parse vite build output assets and write SHA-bound sizes.
 * Run after: (cd dashboard-ui && npm run build)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

const assetsDir = path.resolve('src/dashboard/public/assets');
if (!fs.existsSync(assetsDir)) {
  console.error(JSON.stringify({ ok: false, error: 'assets dir missing — run dashboard-ui build first' }));
  process.exit(2);
}

const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
const rows = files.map((name) => {
  const p = path.join(assetsDir, name);
  const bytes = fs.statSync(p).size;
  return { name, bytes, kb: +(bytes / 1024).toFixed(2) };
});
rows.sort((a, b) => b.bytes - a.bytes);

const entry = rows.find((r) => r.name.startsWith('index-')) || rows[0];
const vendors = rows.filter((r) => r.name.includes('vendor-'));
const over500 = rows.filter((r) => r.bytes > 500 * 1024);

const envelope = {
  stage: 56,
  kind: 'dashboard-bundle-measure',
  exactSha: gitSha(),
  capturedAt: new Date().toISOString(),
  totals: {
    jsChunks: rows.length,
    totalJsKb: +(rows.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(2),
  },
  entry: entry || null,
  largest: rows.slice(0, 12),
  vendors,
  over500kb: over500.map((r) => r.name),
  contracts: {
    entryUnder500kb: entry ? entry.bytes < 500 * 1024 : false,
    hasVendorSplit: vendors.length > 0,
    hasDevRouteChunks: rows.some((r) => /LiveBotStatus|CommandCenter|ServerSlot/i.test(r.name)),
  },
  residual: [
    'gzip sizes not re-measured here (vite log is authoritative for gzip)',
    'sourcemaps excluded from size rows',
  ],
};

console.log(JSON.stringify(envelope, null, 2));

if (process.env.WRITE_PERF_ARTIFACTS !== '0') {
  const dir = path.join('docs/audit/performance', envelope.exactSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '56-bundle.json'), JSON.stringify(envelope, null, 2) + '\n');
}

if (!envelope.contracts.entryUnder500kb) process.exit(3);
if (!envelope.contracts.hasVendorSplit) process.exit(4);
