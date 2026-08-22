import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const matrix = JSON.parse(read('docs/dashboard-api-validation-race-idempotency-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string; expected: string; status: string }>;
};
const mw = read('src/dashboard/middleware/idempotency.ts');
const v2 = read('src/dashboard/routes/v2.ts');
const claimTest = read('tests/security/idempotencyClaim.test.ts');
const clientGate = read('tests/runtime/dashboardMutationIdempotencyRetryGate.test.ts');
const httpDbIntegration = read('tests/security/dashboardSecurityHttpDbIntegration.test.ts');

describe('Stage 38 API validation / race / idempotency matrix', () => {
  it('documents cases', () => {
    expect(matrix.stage).toBe(38);
    expect(matrix.cases.length).toBeGreaterThanOrEqual(8);
  });

  it('mounts idempotency after auth and fail-closes store lookup', () => {
    expect(v2).toContain('v2Router.use(requireAuth)');
    expect(v2).toContain('v2Router.use(idempotency)');
    expect(v2.indexOf('v2Router.use(idempotency)')).toBeGreaterThan(v2.indexOf('v2Router.use(requireAuth)'));
    expect(mw).toContain('X-Idempotency-Key 8..128');
    expect(mw).toContain('hashBody');
    expect(mw).toContain('STALE_PROCESSING_MS');
    expect(mw).toContain('updateMany');
    expect(mw).toContain('IDEMPOTENCY_STORE_UNAVAILABLE');
    expect(mw).toContain("res.status(503)");
    expect(mw).not.toContain('fail-open');
  });

  it('keeps claim unit coverage and client retry key lease gates', () => {
    expect(claimTest.length).toBeGreaterThan(100);
    expect(clientGate).toContain('releaseMutationIdempotencyKey');
    expect(clientGate).toContain('classifyTransportError');
  });

  it('pins Stage 38 runtime negative matrix (length, isolation, store-down, no double side effect)', () => {
    expect(claimTest).toContain('DENY invalid X-Idempotency-Key length with 400 before claim create');
    expect(claimTest).toContain('isolates body mismatch under same key');
    expect(claimTest).toContain('isolates route mismatch under same key');
    expect(claimTest).toContain('fail-closes with 503 IDEMPOTENCY_STORE_UNAVAILABLE');
    expect(claimTest).toContain('fuehrt bei zwei parallelen identischen Requests den Handler nur einmal aus');
    expect(claimTest).toContain('liefert bei erneutem Aufruf das gecachte Ergebnis ohne Handler-Rerun');
    expect(httpDbIntegration).toContain('claims a concurrent mutation atomically in PostgreSQL');
    expect(httpDbIntegration).toContain("expect(claim?.status).toBe('DONE')");
    expect(claimTest).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
    expect(httpDbIntegration).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
