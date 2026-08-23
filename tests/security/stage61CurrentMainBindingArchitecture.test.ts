import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 61 current-main coupling binding', () => {
  it('pins Stage-61 evidence to the Stage-60 merge SHA and preserves the coupling surfaces', () => {
    const matrix = JSON.parse(read('docs/gesamtaudit-2-couplings-matrix.json')) as {
      stage: number;
      basedOnMainSha: string;
      status: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      residual: string[];
    };

    expect(matrix.stage).toBe(61);
    expect(matrix.basedOnMainSha).toBe('6b27bacac6a0f28efa6b70cee42b663e096bd6c5');
    expect(matrix.status).toBe('PARTIAL');
    expect(matrix.contracts.currentMainBinding).toMatch(/exact current main SHA/i);
    expect(matrix.cases.some((c) => c.id === 'current-main-exact-sha-binding' && c.status === 'runtime-verified')).toBe(true);

    for (const p of [
      'tests/security/gesamtaudit2CouplingsArchitecture.test.ts',
      'tests/security/deadCodeLegacyCleanupArchitecture.test.ts',
      'src/dashboard/middleware/auth.ts',
      'src/dashboard/middleware/economyScopeGuard.ts',
      'src/modules/nitrado/jobWorker.ts',
      'src/events/guildMemberRemove.ts',
      'src/modules/moderation/leaveCleanupWorker.ts',
      'src/modules/moderation/leaveCleanupRejoin.ts',
      'src/modules/ai/runtime.ts',
      'src/modules/ai/toolRuntime.ts',
    ]) {
      expect(fs.existsSync(path.join(root, p))).toBe(true);
    }

    expect(matrix.cases.some((c) => c.id === 'full-dynamic-import-orphan-sweep' && c.status === 'residual')).toBe(true);
    expect(matrix.residual.join(' ')).toMatch(/runtime registry|reachability/i);
  });
});
