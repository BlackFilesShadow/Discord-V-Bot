import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const exists = (relative: string): boolean => fs.existsSync(path.resolve(process.cwd(), relative));

const runtime = read('src/modules/nitrado/runtime.ts');
const worker = read('src/modules/nitrado/jobWorker.ts');
const lease = read('src/modules/nitrado/jobLease.ts');
const lock = read('src/modules/nitrado/configMutationLock.ts');
const repository = read('src/modules/nitrado/repository.ts');
const client = read('src/modules/nitrado/nitradoClient.ts');
const circuit = read('src/modules/nitrado/circuitBreaker.ts');
const tokenValidation = read('src/modules/nitrado/tokenValidationCron.ts');
const maintenance = read('src/modules/nitrado/maintenanceRevalidate.ts');
const whitelistReconcile = read('src/modules/whitelist/whitelistSyncCron.ts');
const banReconcile = read('src/modules/bans/banReconciliation.ts');
const mirrorSnapshot = read('src/modules/nitrado/mirror/snapshotService.ts');
const bindingFence = read('src/modules/nitrado/adm/bindingFence.ts');
const liveKnowledge = read('src/modules/ai/liveServerKnowledgeIndex.ts');

describe('Nitrado-1Z final production coupling matrix', () => {
  it('keeps every mutating remote intent behind the durable worker + claim/lease boundary', () => {
    for (const operation of ['WHITELIST_ADD', 'WHITELIST_REMOVE', 'SERVER_BAN_ADD', 'SERVER_BAN_REMOVE', 'RESTART_IF_DOWN']) expect(worker).toContain(operation);
    expect(worker).toContain('claimNitradoJob');
    expect(worker).toContain('heartbeatNitradoJobClaim');
    expect(worker).toContain('transitionClaimedNitradoJob');
    expect(lease).toContain('claimToken');
    expect(lease).toContain('heartbeatAt');
    for (const regression of [
      'tests/runtime/nitradoClientMutationBoundaryGate.test.ts',
      'tests/runtime/nitradoOutboxCouplingGate.test.ts',
      'tests/modules/nitradoRebindOutboxLifecycle.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('serializes worker/config/token/service/delete/reconcile ownership on the canonical per-connection lock', () => {
    expect(lock).toContain('pg_try_advisory_lock');
    expect(lock).toContain('createHash');
    expect(repository).toContain('withConfigMutationLock');
    expect(repository).toContain('updateToken');
    expect(repository).toContain('updateServiceId');
    expect(repository).toContain('deleteSlot');
    expect(tokenValidation).toContain('tryAcquireNitradoConfigMutationLock');
    expect(maintenance).toContain('tryAcquireNitradoConfigMutationLock');
    expect(whitelistReconcile).toContain('tryAcquireNitradoConfigMutationLock');
    expect(banReconcile).toContain('tryAcquireNitradoConfigMutationLock');
    for (const regression of [
      'tests/runtime/nitrado1cMergeVerificationGate.test.ts',
      'tests/runtime/nitradoTokenValidationLockGate.test.ts',
      'tests/runtime/nitradoWhitelistReconcileConnectionLockGate.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('uses nitradoServerId as canonical service binding and fences stale service-aware remote observations', () => {
    expect(repository).toContain('syncAdmBindingState');
    expect(bindingFence).toContain('bindingVersion');
    expect(bindingFence).toContain('nitradoServerId');
    expect(bindingFence).toContain('encryptedToken');
    expect(whitelistReconcile).toContain('nitradoServerId');
    expect(banReconcile).toContain('nitradoServerId');
    // Maintenance revalidation is token-only by design; it has no remote
    // service observation to bind. Its freshness invariant is the shared
    // per-connection lock asserted in the preceding matrix row.
    for (const regression of [
      'tests/runtime/nitradoRemoteReadFreshnessGate.test.ts',
      'tests/runtime/nitradoMirrorLiveBindingGate.test.ts',
      'tests/runtime/nitradoOpsFreshnessGate.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('keeps the complete remote failure taxonomy bounded and circuit-fenced', () => {
    expect(client).toContain('res.status === 429');
    expect(client).toContain('res.status >= 500');
    expect(client).toContain('for (let attempt = 1; attempt <= 3; attempt++)');
    expect(circuit).toContain('HALF_OPEN');
    expect(circuit).toContain('OPEN');
    for (const regression of [
      'tests/modules/nitradoJobWorkerRemoteFailureMatrix.test.ts',
      'tests/runtime/nitradoRemoteFailureMatrixGate.test.ts',
      'tests/modules/nitradoCoreClientRetryMatrix.test.ts',
      'tests/runtime/nitradoCoreClientRetryGate.test.ts',
      'tests/modules/nitradoSignedDownloadRetry.test.ts',
      'tests/runtime/nitradoSignedDownloadRetryGate.test.ts',
      'tests/modules/nitradoMirrorRetry.test.ts',
      'tests/runtime/nitradoMirrorRetryGate.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('runs whitelist, ban expiry/reconciliation, token validation, ADM and feed workers in one symmetric runtime lifecycle', () => {
    for (const start of [
      'startNitradoJobWorker()', 'startBanExpiryRuntime()', 'startBanReconciliationCron()',
      'startTokenValidationCron(client)', 'startWhitelistSyncCron()', 'startAdmLiveSyncCron()',
      'startAdmPostProcessCron()', 'startGameplayFeedRuntime()',
    ]) expect(runtime).toContain(start);
    for (const stop of [
      'stopGameplayFeedRuntime()', 'stopAdmPostProcessCron()', 'stopAdmLiveSyncCron()',
      'stopWhitelistSyncCron()', 'stopTokenValidationCron()', 'stopBanReconciliationCron()',
      'stopBanExpiryRuntime()', 'drainAndStopJobWorker()',
    ]) expect(runtime).toContain(stop);
  });

  it('keeps DB<->Nitrado reconciliation exact-scope and repairable for whitelist and bot-owned bans', () => {
    expect(whitelistReconcile).toContain('guildId');
    expect(whitelistReconcile).toContain('nitradoConnId');
    expect(whitelistReconcile).toContain('getWhitelist');
    expect(banReconcile).toContain('guildId');
    expect(banReconcile).toContain('nitradoConnId');
    expect(banReconcile).toContain('getBanlist');
    expect(banReconcile).toContain('appliedRemotely');
    expect(exists('tests/runtime/nitradoBanReconciliationGate.test.ts')).toBe(true);
    expect(exists('tests/modules/banReconciliation.test.ts')).toBe(true);
  });

  it('keeps mirror -> validated LIVE_SERVER knowledge singleflight, restart-safe and rebind fail-closed', () => {
    expect(mirrorSnapshot).toContain('readCurrentAdmBinding');
    expect(mirrorSnapshot).toContain('acquireMirrorSnapshotLease');
    expect(mirrorSnapshot).toContain('renewMirrorSnapshotLease');
    expect(mirrorSnapshot).toContain('finalizeMirrorSnapshotLease');
    expect(mirrorSnapshot).toContain('indexNitradoSnapshotKnowledge');
    expect(liveKnowledge).toContain('withFreshAdmBinding');
    expect(liveKnowledge).toContain('bindingVersion');
    for (const regression of [
      'tests/runtime/nitradoMirrorLiveBindingGate.test.ts',
      'tests/runtime/nitradoMirrorSingleflightRecoveryGate.test.ts',
      'tests/security/aiLiveServerKnowledgeIndexArchitecture.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('retains explicit multi-server/scope regression coverage across whitelist, ban and ADM paths', () => {
    for (const regression of [
      'tests/modules/whitelistSyncCron.test.ts',
      'tests/modules/banReconciliation.test.ts',
      'tests/modules/nitradoAdmBindingFence.test.ts',
      'tests/modules/nitradoRepositoryConfigLock.test.ts',
      'tests/modules/nitradoRepositoryTokenAtomicity.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });
});
