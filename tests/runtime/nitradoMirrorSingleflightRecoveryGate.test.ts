import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe('Nitrado-1T mirror singleflight/restart recovery architecture', () => {
  const service = read('src/modules/nitrado/mirror/snapshotService.ts');
  const lease = read('src/modules/nitrado/mirror/mirrorLease.ts');
  const indexer = read('src/modules/ai/liveServerKnowledgeIndex.ts');
  const schema = read('prisma/nitrado-mirror-lease.prisma');

  it('persists one token-fenced lease per guild+connection with expiry indexes', () => {
    expect(schema).toContain('model NitradoMirrorLease');
    expect(schema).toContain('leaseToken     String');
    expect(schema).toContain('leaseExpiresAt DateTime');
    expect(schema).toContain('@@id([guildId, nitradoConnId])');
    expect(schema).toContain('@@index([leaseExpiresAt])');
  });

  it('acquires or reuses singleflight before spawning any background remote run', () => {
    const start = between(service, 'export async function startSnapshot', 'async function runSnapshot');
    const acquire = start.indexOf('acquireMirrorSnapshotLease({');
    const reused = start.indexOf('if (lease.reused || !lease.leaseToken)');
    const spawn = start.indexOf('void runSnapshot(lease.snapshotId, binding, lease.leaseToken)');
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(reused).toBeGreaterThan(acquire);
    expect(spawn).toBeGreaterThan(reused);
  });

  it('uses serializable bounded acquisition, expiry recovery and RUNNING-only orphan failure', () => {
    expect(lease).toContain("{ isolationLevel: 'Serializable' }");
    expect(lease).toContain("code === 'P2002' || code === 'P2034'");
    expect(lease).toContain("status: 'RUNNING'");
    expect(lease).toContain("status: 'FAILED'");
    expect(lease).toContain('existing.leaseExpiresAt.getTime() > now.getTime()');
    expect(lease).toContain('leaseToken: existing.leaseToken');
  });

  it('heartbeats long remote traversal and terminalizes only through lease CAS', () => {
    const run = between(service, 'async function runSnapshot', 'function parentOf');
    expect(run).toContain('renewMirrorSnapshotLease({');
    expect(run).toContain('await heartbeat(true)');
    expect(run).toContain('await finalizeMirrorSnapshotLease({');
    expect(run).toContain("where: { id: snapshotId, guildId, nitradoConnId: connId, status: 'RUNNING' }");
    expect(run).toContain("Staler/ersetzter Snapshot verwirft finale Side-Effects");
  });

  it('retains singleflight until lease-locked LIVE_SERVER commit finishes, then releases exact token', () => {
    const run = between(service, 'async function runSnapshot', 'function parentOf');
    const finalize = run.indexOf('finalizeMirrorSnapshotLease({');
    const index = run.indexOf('indexNitradoSnapshotKnowledge({');
    const release = run.indexOf('releaseMirrorSnapshotLease({', index);
    expect(finalize).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(finalize);
    expect(release).toBeGreaterThan(index);
    expect(run).toContain('mirrorLeaseToken: leaseToken');

    const tx = indexer.indexOf('prisma.$transaction');
    const leaseFence = indexer.indexOf('refreshMirrorLeaseForCommit(', tx);
    const cleanup = indexer.indexOf('deleteGeneratedLiveServerKnowledge(', tx);
    expect(leaseFence).toBeGreaterThan(tx);
    expect(cleanup).toBeGreaterThan(leaseFence);
  });

  it('refreshes lease with an UPDATE so recovery is row-locked through the knowledge commit', () => {
    expect(lease).toContain('export async function refreshMirrorLeaseForCommit');
    expect(lease).toContain('client.nitradoMirrorLease.updateMany({');
    expect(lease).toContain('leaseExpiresAt: { gt: now }');
    expect(lease).toContain('throw new NitradoMirrorLeaseLostError()');
  });
});
