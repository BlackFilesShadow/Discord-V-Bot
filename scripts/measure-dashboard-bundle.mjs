/**
 * Stage 56 — measure the emitted dashboard JS bundle against explicit budgets.
 * Run after: (cd dashboard-ui && npm run build) or as part of that build script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const NORMAL_CHUNK_LIMIT_BYTES = 500 * 1024;
const RADAR_VENDOR_RAW_LIMIT_BYTES = 1024 * 1024;
const RADAR_VENDOR_GZIP_LIMIT_BYTES = 300 * 1024;
const RADAR_VENDOR_RE = /^vendor-radar-map-.*\.js$/;

function exactSha() {
  if (/^[0-9a-f]{40}$/i.test(process.env.STAGE56_EXACT_SHA || '')) {
    return process.env.STAGE56_EXACT_SHA;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      const prHead = event?.pull_request?.head?.sha;
      if (/^[0-9a-f]{40}$/i.test(prHead || '')) return prHead;
    } catch {
      // Fall through to the push SHA / local git fallback.
    }
  }

  if (/^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA || '')) return process.env.GITHUB_SHA;

  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const assetsDir = path.resolve('src/dashboard/public/assets');
if (!fs.existsSync(assetsDir)) {
  console.error(JSON.stringify({ ok: false, error: 'assets dir missing — run dashboard-ui build first' }));
  process.exit(2);
}

const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));
const rows = files.map((name) => {
  const p = path.join(assetsDir, name);
  const source = fs.readFileSync(p);
  const bytes = source.length;
  const gzipBytes = gzipSync(source).length;
  return {
    name,
    bytes,
    kb: +(bytes / 1024).toFixed(2),
    gzipBytes,
    gzipKb: +(gzipBytes / 1024).toFixed(2),
  };
});
rows.sort((a, b) => b.bytes - a.bytes);

const entry = rows.find((r) => r.name.startsWith('index-')) || rows[0];
const vendors = rows.filter((r) => r.name.includes('vendor-'));
const radarVendors = rows.filter((r) => RADAR_VENDOR_RE.test(r.name));
const oversizedNonRadar = rows.filter(
  (r) => r.bytes > NORMAL_CHUNK_LIMIT_BYTES && !RADAR_VENDOR_RE.test(r.name),
);
const radarRawOverBudget = radarVendors.filter((r) => r.bytes > RADAR_VENDOR_RAW_LIMIT_BYTES);
const radarGzipOverBudget = radarVendors.filter((r) => r.gzipBytes > RADAR_VENDOR_GZIP_LIMIT_BYTES);
const sha = exactSha();

const contracts = {
  entryUnder500kb: entry ? entry.bytes < NORMAL_CHUNK_LIMIT_BYTES : false,
  nonRadarChunksUnder500kb: oversizedNonRadar.length === 0,
  singleLazyRadarVendor: radarVendors.length === 1,
  radarVendorRawUnder1MiB: radarVendors.length === 1 && radarRawOverBudget.length === 0,
  radarVendorGzipUnder300KiB: radarVendors.length === 1 && radarGzipOverBudget.length === 0,
  hasVendorSplit: vendors.length > 0,
  hasDevRouteChunks: rows.some((r) => /LiveBotStatus|CommandCenter|ServerSlot/i.test(r.name)),
};

const envelope = {
  stage: 56,
  kind: 'dashboard-bundle-measure',
  exactSha: sha,
  capturedAt: new Date().toISOString(),
  budgets: {
    normalChunkRawKiB: 500,
    radarVendorRawKiB: 1024,
    radarVendorGzipKiB: 300,
  },
  totals: {
    jsChunks: rows.length,
    totalJsKb: +(rows.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(2),
    totalJsGzipKb: +(rows.reduce((s, r) => s + r.gzipBytes, 0) / 1024).toFixed(2),
  },
  entry: entry || null,
  largest: rows.slice(0, 12),
  vendors,
  radarVendors,
  oversizedNonRadar: oversizedNonRadar.map((r) => r.name),
  radarRawOverBudget: radarRawOverBudget.map((r) => r.name),
  radarGzipOverBudget: radarGzipOverBudget.map((r) => r.name),
  contracts,
  residual: [],
};

console.log(JSON.stringify(envelope, null, 2));

const outputPath = process.env.STAGE56_OUTPUT_PATH
  || (process.env.GITHUB_ACTIONS === 'true' ? path.join('stage56-artifacts', `${sha}.json`) : null);
if (outputPath) writeJson(path.resolve(outputPath), envelope);

if (process.env.WRITE_PERF_ARTIFACTS === '1') {
  writeJson(path.join('docs/audit/performance', sha, '56-bundle.json'), envelope);
}

if (!contracts.entryUnder500kb) process.exit(3);
if (!contracts.hasVendorSplit) process.exit(4);
if (!contracts.nonRadarChunksUnder500kb) process.exit(5);
if (!contracts.singleLazyRadarVendor) process.exit(6);
if (!contracts.radarVendorRawUnder1MiB) process.exit(7);
if (!contracts.radarVendorGzipUnder300KiB) process.exit(8);
