import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

interface StatusClass {
  id: string;
  class: string;
  meaning: string;
  clientBehavior: string;
  uiExpectation: string;
  examples: string;
  status: string;
}

interface ErrorMatrix {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  contracts: Record<string, string>;
  statusClasses: StatusClass[];
  surfaces: Array<{ id: string; path: string; role: string; status: string }>;
  invariants: string[];
}

const matrix = JSON.parse(read('docs/dashboard-error-state-matrix.json')) as ErrorMatrix;
const apiClient = read('dashboard-ui/src/lib/api.ts');
const server = read('src/dashboard/server.ts');
const useDevStatus = read('dashboard-ui/src/lib/useDevStatus.ts');
const auditLogsUi = read('dashboard-ui/src/pages/dev/AuditLogs.tsx');
const toast = read('dashboard-ui/src/lib/toast.tsx');

const requiredStatus: Array<keyof StatusClass> = [
  'id', 'class', 'meaning', 'clientBehavior', 'uiExpectation', 'examples', 'status',
];

describe('Stage 29 dashboard error state matrix', () => {
  it('inventories required status/transport classes with unique ids', () => {
    expect(matrix.stage).toBe(29);
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.statusClasses.length).toBeGreaterThanOrEqual(10);
    expect(matrix.invariants.length).toBeGreaterThanOrEqual(3);
    const ids = new Set<string>();
    for (const row of matrix.statusClasses) {
      for (const key of requiredStatus) {
        expect(String(row[key] ?? '').trim()).not.toBe('');
      }
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
    for (const cls of ['400', '401', '403', '404', '409', '429', '5xx', 'offline', 'timeout', 'network']) {
      expect(matrix.statusClasses.some(row => row.class === cls)).toBe(true);
    }
  });

  it('central API client classifies HTTP and transport failures without masking success', () => {
    expect(apiClient).toContain('export class ApiError');
    expect(apiClient).toContain('classifyTransportError');
    expect(apiClient).toContain('describeApiError');
    expect(apiClient).toContain('API_REQUEST_TIMEOUT_MS');
    expect(apiClient).toContain('fetchWithTimeout');
    expect(apiClient).toContain("'NETWORK_OFFLINE'");
    expect(apiClient).toContain("'REQUEST_TIMEOUT'");
    expect(apiClient).toContain("'NETWORK_ERROR'");
    expect(apiClient).toContain('if (!res.ok)');
    expect(apiClient).toContain('throw new ApiError');
    // Success path only after decode of ok response.
    expect(apiClient).toContain('const result = await decode<T>(await fetchWithTimeout(');
    expect(apiClient).toContain('if (lease) releaseMutationIdempotencyKey(lease)');
  });

  it('express final handler is fail-closed non-2xx and does not leak stacks', () => {
    expect(server).toContain('if (res.headersSent) return');
    expect(server).toContain("code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'");
    expect(server).toContain("error: clientMessage");
    expect(server).not.toContain('res.status(200).json({ error');
    expect(server).not.toContain('stack:');
  });

  it('DEV polling and audit UI keep visible errors and backoff without success masking', () => {
    expect(useDevStatus).toContain('e.status === 429 || e.status >= 500');
    expect(useDevStatus).toContain('setBackoffMs');
    expect(auditLogsUi).toContain('describeApiError');
    expect(auditLogsUi).toContain('setData(null)');
    expect(auditLogsUi).toContain("variant: 'danger'");
    expect(toast).toContain('Dedup');
  });
});
