/**
 * Wave J — Stages 60–62 structural gesamtaudit scan (SHA-bound).
 * Detects orphan routes, missing mounts, worker surfaces, and production posture pins.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const r = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

function walk(dir, acc = []) {
  if (!exists(dir)) return acc;
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, ent.name).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'coverage') continue;
      walk(rel, acc);
    } else acc.push(rel);
  }
  return acc;
}

const findings = [];
const ok = [];

// --- Stage 60: architecture corpus ---
const archTests = walk('tests/security').filter((f) => /Architecture\.test\.ts$/.test(f));
if (archTests.length >= 40) ok.push({ id: 'arch-gate-corpus', n: archTests.length });
else findings.push({ id: 'arch-gate-corpus-low', n: archTests.length });

const v2 = r('src/dashboard/routes/v2.ts');
if (v2.includes('v2Router.use(requireAuth)') && v2.includes('v2Router.use(idempotency)')) {
  ok.push({ id: 'v2-auth-idempotency-mount' });
} else findings.push({ id: 'v2-auth-idempotency-missing' });

const toolRuntime = r('src/modules/ai/toolRuntime.ts');
if (/AuthZ|authorization|guildId|gameserver|idempoten/i.test(toolRuntime)) {
  ok.push({ id: 'ai-tool-runtime-security-path' });
} else findings.push({ id: 'ai-tool-runtime-weak' });

// --- Stage 61: couplings ---
const server = r('src/dashboard/server.ts');
const mounts = [...server.matchAll(/app\.(?:use|get|post)\(\s*'([^']+)'/g)].map((m) => m[1]);
const v2Mounts = [...v2.matchAll(/v2Router\.use\(\s*'([^']+)'/g)].map((m) => m[1]);

// Worker surfaces referenced from bootstrap / modules
const workers = [
  'src/modules/nitrado/jobWorker.ts',
  'src/modules/moderation/leaveCleanupWorker.ts',
].filter(exists);
if (workers.length === 2) ok.push({ id: 'worker-surfaces-present', workers });
else findings.push({ id: 'worker-surface-missing', workers });

// AI tools must not be callable without registry path (source pin)
const aiRuntime = r('src/modules/ai/runtime.ts');
if (/toolRuntime|executeTool|getTool/i.test(aiRuntime)) ok.push({ id: 'ai-runtime-tool-wiring' });
else findings.push({ id: 'ai-runtime-tool-wiring-missing' });

// Economy scope coupling
const econ = r('src/dashboard/middleware/economyScopeGuard.ts');
if (econ.includes('requireSafeDashboardEconomyScope')) ok.push({ id: 'economy-scope-coupling' });
else findings.push({ id: 'economy-scope-missing' });

// Leave/rejoin coupling
if (exists('src/events/guildMemberRemove.ts') && exists('src/modules/moderation/leaveCleanupRejoin.ts')) {
  ok.push({ id: 'leave-rejoin-coupling' });
} else findings.push({ id: 'leave-rejoin-missing' });

// Discord ↔ dashboard auth coupling
const authMw = r('src/dashboard/middleware/auth.ts');
if (authMw.includes('GUILD_MEMBERSHIP_REQUIRED') || authMw.includes('requireAuth')) {
  ok.push({ id: 'discord-dashboard-auth-coupling' });
} else findings.push({ id: 'auth-coupling-missing' });

// Producer without consumer: NitradoJob model requires jobWorker
const schema = r('prisma/schema.prisma');
if (schema.includes('model NitradoJob') && exists('src/modules/nitrado/jobWorker.ts')) {
  ok.push({ id: 'nitrado-job-producer-consumer' });
} else findings.push({ id: 'nitrado-job-orphan' });

// --- Stage 62: production reality ---
const envEx = r('.env.example');
const prodPins = {
  dockerfile: exists('Dockerfile'),
  compose: exists('docker-compose.yml'),
  deployDir: exists('deploy'),
  smoke: exists('deploy/smoke.sh') || exists('scripts'),
  metricsDefaultOff: /METRICS_ENABLED\s*=\s*false/.test(envEx),
  sessionSecret: /SESSION_SECRET=/.test(envEx),
  encryptionKey: /ENCRYPTION_KEY=/.test(envEx),
  healthRoute: /health|ready/i.test(server),
  noEnvCopyInDocker: !/COPY\s+\.env\b/.test(r('Dockerfile')),
  sbomBlocking: /Generate SBOMs \(CycloneDX, blocking\)/.test(r('.github/workflows/ci.yml')),
  rootHighBlocking: /Root npm audit \(high blocking\)/.test(r('.github/workflows/ci.yml')),
};
for (const [k, v] of Object.entries(prodPins)) {
  if (v) ok.push({ id: `prod-${k}` });
  else findings.push({ id: `prod-${k}-fail` });
}

const envelope = {
  stages: [60, 61, 62],
  kind: 'gesamtaudit-structural-scan',
  exactSha: gitSha(),
  capturedAt: new Date().toISOString(),
  inventory: {
    architectureTests: archTests.length,
    serverMounts: mounts,
    v2Mounts,
    workers,
  },
  ok,
  findings,
  residual: [
    'Does not replace live production deploy smoke (Stage 67)',
    'Coupling scan is static/source-based — event-driven dynamic imports need manual registry review',
    'Staging multi-service chaos still residual (Stage 59)',
  ],
};

console.log(JSON.stringify(envelope, null, 2));

if (process.env.WRITE_PERF_ARTIFACTS !== '0') {
  const dir = path.join(root, 'docs/audit/performance', envelope.exactSha);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '60-62-gesamtaudit.json'), JSON.stringify(envelope, null, 2) + '\n');
}

if (findings.length) process.exit(2);
