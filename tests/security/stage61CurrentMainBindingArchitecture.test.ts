import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 61 current-main coupling binding', () => {
  it('pins complete Stage-61 evidence to the audited post-407 main SHA', () => {
    const matrix = JSON.parse(read('docs/gesamtaudit-2-couplings-matrix.json')) as {
      stage: number;
      basedOnMainSha: string;
      status: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      evidence?: string[];
      residual: string[];
    };

    expect(matrix.stage).toBe(61);
    expect(matrix.basedOnMainSha).toBe('43f800ce67bd37f4a51b5f8abff150ae35ebf50a');
    expect(matrix.status).toBe('VERIFIED');
    expect(matrix.contracts.currentMainBinding).toContain('43f800ce67bd37f4a51b5f8abff150ae35ebf50a');
    expect(matrix.contracts.runtimeReachability).toMatch(/AST-based graph|runtime|reachability/i);
    expect(matrix.cases.some((c) => c.id === 'current-main-exact-sha-binding' && c.status === 'runtime-verified')).toBe(true);
    expect(matrix.cases.some((c) => c.id === 'full-dynamic-import-orphan-sweep' && c.status === 'runtime-verified')).toBe(true);
    expect(matrix.residual).toEqual([]);

    for (const p of [
      'tests/security/gesamtaudit2CouplingsArchitecture.test.ts',
      'tests/security/deadCodeLegacyCleanupArchitecture.test.ts',
      'tests/security/stage61RuntimeReachabilityArchitecture.test.ts',
      'src/index.ts',
      'src/events/interactionCreateComposite.ts',
      'src/commands/handler.ts',
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
  });
});
