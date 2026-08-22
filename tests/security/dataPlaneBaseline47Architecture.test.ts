import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Stage 47 real data-plane baseline architecture', () => {
  const script = read('scripts/data-plane-baseline-47.mjs');
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const metrics = read('src/utils/metrics.ts');
  const worker = read('src/modules/nitrado/jobWorker.ts');
  const ci = read('.github/workflows/ci.yml');
  const verification2 = read('.github/workflows/verification2.yml');

  it('measures real PostgreSQL pool saturation and persistent queue state', () => {
    expect(pkg.scripts?.['perf:data-plane-47']).toBe('node scripts/data-plane-baseline-47.mjs');
    expect(script).toContain("import pg from 'pg'");
    expect(script).toContain("SELECT pg_sleep(0.04)");
    expect(script).toContain('peakWaiting');
    expect(script).toContain('FOR UPDATE SKIP LOCKED');
    expect(script).toContain('"NitradoJob"');
    expect(script).toContain('statusNextRunIndexPresent');
    expect(script).toContain('STAGE47_REQUIRE_LIVE=1 requires both DATABASE_URL and REDIS_URL');
  });

  it('measures real Redis ping, round-trip, concurrent writes and TTL behavior', () => {
    expect(script).toContain("import { createClient } from 'redis'");
    expect(script).toContain('await client.ping()');
    expect(script).toContain('SET/GET round-trip mismatch');
    expect(script).toContain('Promise.all(Array.from({ length: 32 }');
    expect(script).toContain('await client.pTTL(ttlKey)');
    expect(script).toContain('await client.quit()');
  });

  it('exports production queue depth, oldest-pending and in-flight gauges', () => {
    expect(metrics).toContain('vbot_nitrado_job_queue_depth');
    expect(metrics).toContain('vbot_nitrado_job_oldest_pending_age_seconds');
    expect(metrics).toContain('vbot_nitrado_job_worker_in_flight');
    expect(metrics).toContain("['PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD'] as const");
    expect(worker).toContain('export async function refreshNitradoJobQueueMetrics');
    expect(worker).toContain("by: ['status']");
    expect(worker).toContain("where: { status: 'PENDING' }");
    expect(worker).toContain('await refreshNitradoJobQueueMetrics();');
  });

  it.each([
    ['CI/CD Pipeline', ci],
    ['Verification 2', verification2],
  ])('makes the live probe and Redis service mandatory in %s', (_name, workflow) => {
    expect(workflow).toContain('image: redis:7.4-alpine');
    expect(workflow).toContain('Stage 47 live PostgreSQL, Redis and worker-queue baseline');
    expect(workflow).toContain('STAGE47_REQUIRE_LIVE: \'1\'');
    expect(workflow).toContain('REDIS_URL: redis://localhost:6379');
    expect(workflow).toContain('npm run perf:data-plane-47');
    expect(workflow).toContain('Upload Stage 47 data-plane evidence');
  });
});
