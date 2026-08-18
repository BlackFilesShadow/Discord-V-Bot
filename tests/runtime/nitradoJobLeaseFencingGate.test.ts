import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKER = fs.readFileSync(path.join(ROOT, 'src/modules/nitrado/jobWorker.ts'), 'utf8');
const LEASE = fs.readFileSync(path.join(ROOT, 'src/modules/nitrado/jobLease.ts'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma/nitrado-job-lease.prisma'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'prisma/migrations/20260818152000_nitrado_1i_job_lease/migration.sql'),
  'utf8',
);

function compact(value: string): string {
  return value.replace(/\s+/g, ' ');
}

describe('Nitrado-1I durable worker claim fencing gate', () => {
  it('keeps a durable token+heartbeat lease with cascade cleanup', () => {
    const schema = compact(SCHEMA);
    const migration = compact(MIGRATION);

    expect(schema).toContain('model NitradoJobLease');
    expect(schema).toContain('jobId String @id');
    expect(schema).toContain('claimToken String @unique');
    expect(schema).toContain('heartbeatAt DateTime');
    expect(schema).toContain('@@index([heartbeatAt])');
    expect(migration).toContain('REFERENCES "NitradoJob"("id") ON DELETE CASCADE');
  });

  it('fences every claimed transition by deleting the exact lease before the RUNNING job CAS', () => {
    const source = compact(LEASE);
    const transition = source.indexOf('export async function transitionClaimedNitradoJob');
    const leaseDelete = source.indexOf('tx.nitradoJobLease.deleteMany', transition);
    const token = source.indexOf('claimToken: claim.claimToken', leaseDelete);
    const jobUpdate = source.indexOf('tx.nitradoJob.updateMany', leaseDelete);

    expect(transition).toBeGreaterThan(-1);
    expect(leaseDelete).toBeGreaterThan(transition);
    expect(token).toBeGreaterThan(leaseDelete);
    expect(jobUpdate).toBeGreaterThan(token);
    expect(source.slice(jobUpdate, jobUpdate + 220)).toContain("status: 'RUNNING'");
  });

  it('uses heartbeat-based recovery and preserves a bounded legacy rolling-deploy fallback', () => {
    const source = compact(LEASE);
    expect(source).toContain('NITRADO_JOB_LEASE_STALE_MS = 5 * 60 * 1000');
    expect(source).toContain('NITRADO_JOB_HEARTBEAT_INTERVAL_MS = 60 * 1000');
    expect(source).toContain('where: { heartbeatAt: { lt: staleBefore } }');
    expect(source).toContain("where: { status: 'RUNNING', updatedAt: { lt: staleBefore } }");
    expect(source).toContain('if (lease) continue');
  });

  it('claims through the lease module and never dispatches a naked job id', () => {
    const source = compact(WORKER);
    expect(source).toContain('const claim = await claimNitradoJob({ id: c.id, guildId: c.guildId })');
    expect(source).toContain('const claimed: NitradoJobClaim[] = []');
    expect(source).toContain('await Promise.allSettled(claimed.map(executeJob))');
    expect(source).toContain('export async function executeJob(claim: NitradoJobClaim)');
    expect(source).not.toContain('export async function executeJob(jobId: string)');
  });

  it('renews ownership before every direct remote mutation surface', () => {
    const source = compact(WORKER);
    const mutators = [
      'client.addToWhitelist',
      'client.removeFromWhitelist',
      'client.addToBanlist',
      'client.removeFromBanlist',
      'client.start',
    ];

    for (const mutator of mutators) {
      let offset = 0;
      let found = 0;
      while (true) {
        const call = source.indexOf(`await ${mutator}`, offset);
        if (call < 0) break;
        found += 1;
        const guard = source.lastIndexOf('await ensureClaimOwned()', call);
        expect(guard).toBeGreaterThan(-1);
        expect(call - guard).toBeLessThan(700);
        offset = call + mutator.length;
      }
      expect(found).toBeGreaterThan(0);
    }
  });

  it('routes DONE, DEAD, retry and connection-lock requeue through the fenced transition primitive', () => {
    const source = compact(WORKER);
    expect(source).toContain('transitionClaimedNitradoJob(claim');
    expect(source).toContain("status: 'DONE'");
    expect(source).toContain("status: 'DEAD'");
    expect(source).toContain("status: 'PENDING'");
    expect(source).toContain('recoverStaleNitradoJobClaims(new Date())');
    expect(source).not.toContain("where: { status: 'RUNNING', updatedAt: { lt: staleCutoff } }");
  });
});
