import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
const exists = (relative: string): boolean => fs.existsSync(path.resolve(process.cwd(), relative));

const lease = read('src/modules/nitrado/jobLease.ts');
const worker = read('src/modules/nitrado/jobWorker.ts');
const expiry = read('src/modules/bans/expiryRuntime.ts');

describe('Nitrado-1Z restart/duplicate/expiry recovery matrix', () => {
  it('fences duplicate workers with a durable claim token, heartbeat and stale-claim recovery', () => {
    expect(lease).toContain("status: 'PENDING'");
    expect(lease).toContain("data: { status: 'RUNNING'");
    expect(lease).toContain('claimToken');
    expect(lease).toContain('heartbeatAt');
    expect(lease).toContain('recoverStaleNitradoJobClaims');
    expect(lease).toContain("status: 'RUNNING'");
    expect(lease).toContain("data: { status: 'PENDING'");
    expect(worker).toContain('recoverStaleNitradoJobClaims');

    for (const regression of [
      'tests/modules/nitradoJobLease.test.ts',
      'tests/runtime/nitradoJobLeaseFencingGate.test.ts',
      'tests/modules/nitradoJobWorker.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('keeps ambiguous/post-write whitelist outcomes repairable instead of blindly duplicating mutations', () => {
    for (const regression of [
      'tests/modules/nitradoWhitelistWorkerIntent.test.ts',
      'tests/modules/nitradoWhitelistPostWriteRecovery.test.ts',
      'tests/runtime/nitradoWhitelistIntentGate.test.ts',
    ]) expect(exists(regression)).toBe(true);
  });

  it('keeps ban expiry as a durable removal path with reconciliation coverage', () => {
    expect(expiry).toContain('expiresAt');
    expect(expiry).toContain('enqueueServerBanRemove');
    expect(exists('tests/modules/banExpiryRuntime.test.ts')).toBe(true);
    expect(exists('tests/modules/banReconciliation.test.ts')).toBe(true);
    expect(exists('tests/runtime/nitradoBanReconciliationGate.test.ts')).toBe(true);
  });

  it('pins the worker HTTP/status matrix that covers permanent, transient, offline and restart-if-down behavior', () => {
    expect(exists('tests/modules/nitradoJobWorkerRemoteFailureMatrix.test.ts')).toBe(true);
    expect(exists('tests/runtime/nitradoRemoteFailureMatrixGate.test.ts')).toBe(true);
    expect(worker).toContain("case 'RESTART_IF_DOWN'");
    expect(worker).toContain("status === 'stopped'");
  });
});
