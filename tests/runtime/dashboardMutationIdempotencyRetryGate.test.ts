import fs from 'node:fs';
import path from 'node:path';

const clientSource = fs.readFileSync(
  path.resolve(process.cwd(), 'dashboard-ui/src/lib/api.ts'),
  'utf8',
);
const middlewareSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/dashboard/middleware/idempotency.ts'),
  'utf8',
);

describe('Economy-1L dashboard mutation idempotency retry architecture', () => {
  it('persists only a SHA-256 fingerprint plus pending key for unconfirmed JSON mutations', () => {
    expect(clientSource).toContain("const PENDING_IDEMPOTENCY_PREFIX = 'vbot:pending-idempotency:'");
    expect(clientSource).toContain("crypto.subtle.digest('SHA-256', bytes)");
    expect(clientSource).toContain('storage.setItem(storageKey, key)');
    expect(clientSource).not.toContain('storage.setItem(signature');
    expect(clientSource).not.toContain('storage.setItem(payload');
  });

  it('reuses one key for the same pending mutation and releases it only after successful decode', () => {
    expect(clientSource).toContain('const pendingMutationKeys = new Map<string, string>()');
    expect(clientSource).toContain('const pendingMutationKeyLoads = new Map<string, Promise<MutationIdempotencyLease>>()');
    expect(clientSource).toContain('lease = await acquireMutationIdempotencyKey(signature)');
    expect(clientSource).toContain("headers['X-Idempotency-Key'] = lease.key");

    const decode = clientSource.indexOf('const result = await decode<T>(await fetchWithTimeout(');
    const release = clientSource.indexOf('if (lease) releaseMutationIdempotencyKey(lease);', decode);
    expect(decode).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(decode);
    // Transport failures must not release the pending key (retry keeps same key).
    expect(clientSource).toContain('throw classifyTransportError(err)');
  });

  it('keeps FormData outside the stable JSON fingerprint contract', () => {
    expect(clientSource).toContain('FormData/Uploads haben keinen stabilen serialisierten Payload-Fingerprint');
    expect(clientSource).toContain("'X-Idempotency-Key': createIdempotencyKey()");
  });

  it('reclaims stale or expired server claims with compare-and-swap instead of unconditional update', () => {
    expect(middlewareSource).toContain('const takeover = await prisma.idempotencyKey.updateMany({');
    expect(middlewareSource).toContain('status: existing.status');
    expect(middlewareSource).toContain('createdAt: existing.createdAt');
    expect(middlewareSource).toContain('if (takeover.count !== 1)');

    const recoveryComment = middlewareSource.indexOf('Compare-and-Swap uebernehmen');
    const unconditionalUpdate = middlewareSource.indexOf('await prisma.idempotencyKey.update({', recoveryComment);
    const responseFinalize = middlewareSource.indexOf('// Antwort erfassen und den Claim beim Response-Ende finalisieren.');
    expect(recoveryComment).toBeGreaterThanOrEqual(0);
    expect(unconditionalUpdate === -1 || unconditionalUpdate > responseFinalize).toBe(true);
  });
});
