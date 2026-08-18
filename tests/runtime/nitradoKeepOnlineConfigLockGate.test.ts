import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const dashboard = read('src/dashboard/routes/v2/dashboard.ts');
const worker = read('src/modules/nitrado/jobWorker.ts');
const configLock = read('src/modules/nitrado/configMutationLock.ts');
const keepOnlineJobs = read('src/modules/nitrado/keepOnlineJobs.ts');

describe('Nitrado-1F keep-online config/worker serialization gate', () => {
  it('uses the existing shared Nitrado config lock instead of a second dashboard lock implementation', () => {
    expect(dashboard).toContain('tryAcquireNitradoConfigMutationLock,');
    expect(dashboard).toContain("from '../../../modules/nitrado/configMutationLock';");
    expect(dashboard).toContain('keepOnlineLock = await tryAcquireNitradoConfigMutationLock(conn.id);');
    expect(dashboard).not.toContain('pg_try_advisory_lock');
    expect(dashboard).not.toContain('CONN_LOCK_NAMESPACE');

    expect(configLock).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(worker).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
  });

  it('fails busy keep-online writes closed before any settings transaction', () => {
    const patchAt = dashboard.indexOf("dashboardRouter.patch('/server/:slot/settings'");
    const acquireAt = dashboard.indexOf('keepOnlineLock = await tryAcquireNitradoConfigMutationLock(conn.id);', patchAt);
    const busyAt = dashboard.indexOf('respondKeepOnlineBusy(res);', acquireAt);
    const invokeTxAt = dashboard.indexOf('s = await persistSettings();', acquireAt);

    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(acquireAt).toBeGreaterThan(patchAt);
    expect(busyAt).toBeGreaterThan(acquireAt);
    expect(invokeTxAt).toBeGreaterThan(busyAt);
    expect(dashboard).toContain("code: 'NITRADO_CONNECTION_BUSY'");
  });

  it('revalidates exact server identity under the lock before committing keep-online', () => {
    const patchAt = dashboard.indexOf("dashboardRouter.patch('/server/:slot/settings'");
    const acquireAt = dashboard.indexOf('keepOnlineLock = await tryAcquireNitradoConfigMutationLock(conn.id);', patchAt);
    const freshAt = dashboard.indexOf('const freshConn = await resolveSlotConn(scope, slotParam, res);', acquireAt);
    const identityAt = dashboard.indexOf('if (freshConn.id !== conn.id)', freshAt);
    const conflictAt = dashboard.indexOf('respondKeepOnlineVersionConflict(res);', identityAt);
    const persistAt = dashboard.indexOf('s = await persistSettings();', freshAt);

    expect(freshAt).toBeGreaterThan(acquireAt);
    expect(identityAt).toBeGreaterThan(freshAt);
    expect(conflictAt).toBeGreaterThan(identityAt);
    expect(persistAt).toBeGreaterThan(conflictAt);
    expect(dashboard).toContain("code: 'NITRADO_SLOT_VERSION_CONFLICT'");
  });

  it('keeps keep-online flag update and pending auto-start cancellation in one transaction invoked under the lock', () => {
    const persistDefAt = dashboard.indexOf('const persistSettings = async () => prisma.$transaction(async tx => {');
    const flagAt = dashboard.indexOf('await tx.nitradoConnection.updateMany({', persistDefAt);
    const cancelAt = dashboard.indexOf('await cancelPendingKeepOnlineJobs(', flagAt);
    const persistEndAt = dashboard.indexOf('let keepOnlineLock:', cancelAt);
    const acquireAt = dashboard.indexOf('keepOnlineLock = await tryAcquireNitradoConfigMutationLock(conn.id);', persistEndAt);
    const invokeAt = dashboard.indexOf('s = await persistSettings();', acquireAt);
    const finallyAt = dashboard.indexOf('} finally {', invokeAt);
    const releaseAt = dashboard.indexOf('await keepOnlineLock?.release();', finallyAt);

    expect(flagAt).toBeGreaterThan(persistDefAt);
    expect(cancelAt).toBeGreaterThan(flagAt);
    expect(cancelAt).toBeLessThan(persistEndAt);
    expect(invokeAt).toBeGreaterThan(acquireAt);
    expect(finallyAt).toBeGreaterThan(invokeAt);
    expect(releaseAt).toBeGreaterThan(finallyAt);

    expect(keepOnlineJobs).toContain("operation: 'RESTART_IF_DOWN'");
    expect(keepOnlineJobs).toContain("status: 'PENDING'");
    expect(keepOnlineJobs).toContain("status: 'DEAD'");
  });

  it('fails closed when a previously resolved connection disappears before its exact read', () => {
    const resolveAt = dashboard.indexOf('async function resolveSlotConn(');
    const exactReadAt = dashboard.indexOf('const conn = await prisma.nitradoConnection.findFirst({', resolveAt);
    const missingAt = dashboard.indexOf('if (!conn) {', exactReadAt);
    const conflictAt = dashboard.indexOf('respondKeepOnlineVersionConflict(res);', missingAt);

    expect(exactReadAt).toBeGreaterThan(resolveAt);
    expect(missingAt).toBeGreaterThan(exactReadAt);
    expect(conflictAt).toBeGreaterThan(missingAt);
  });

  it('keeps worker auto-start inside the same per-connection lock with a fresh disable check before start', () => {
    const workerAcquireAt = worker.indexOf('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);');
    const workerTryAt = worker.indexOf('try {', workerAcquireAt);
    const restartAt = worker.indexOf("case 'RESTART_IF_DOWN':", workerTryAt);
    const initialEnabledAt = worker.indexOf('if (!conn.keepOnlineEnabled)', restartAt);
    const statusAt = worker.indexOf('await client.getServiceStatus(conn.nitradoServerId);', initialEnabledAt);
    const freshReadAt = worker.indexOf('const freshKeepOnline = await prisma.nitradoConnection.findFirst({', statusAt);
    const freshEnabledAt = worker.indexOf('if (!freshKeepOnline?.keepOnlineEnabled)', freshReadAt);
    const startAt = worker.indexOf('await client.start(conn.nitradoServerId);', freshEnabledAt);
    const workerFinallyAt = worker.indexOf('} finally {', startAt);
    const workerReleaseAt = worker.indexOf('await connectionLock.release();', workerFinallyAt);

    expect(workerAcquireAt).toBeGreaterThanOrEqual(0);
    expect(restartAt).toBeGreaterThan(workerAcquireAt);
    expect(initialEnabledAt).toBeGreaterThan(restartAt);
    expect(statusAt).toBeGreaterThan(initialEnabledAt);
    expect(freshReadAt).toBeGreaterThan(statusAt);
    expect(freshEnabledAt).toBeGreaterThan(freshReadAt);
    expect(startAt).toBeGreaterThan(freshEnabledAt);
    expect(workerReleaseAt).toBeGreaterThan(startAt);
  });
});
