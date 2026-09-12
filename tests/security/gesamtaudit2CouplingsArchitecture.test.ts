import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/gesamtaudit-2-couplings-matrix.json')) as {
  stage: number;
  status: string;
  cases: Array<{ id: string; status: string }>;
  contracts: Record<string, string>;
  evidence?: string[];
  residual: string[];
};
const auth = r('src/dashboard/middleware/auth.ts');
const incident = r('src/dashboard/routes/v2/devIncident.ts');
const econ = r('src/dashboard/middleware/economyScopeGuard.ts');
const aiRuntime = r('src/modules/ai/runtime.ts');
const schema = r('prisma/schema.prisma');

describe('Stage 61 gesamtaudit 2 couplings', () => {
  it('requires the coupling audit and runtime reachability sweep to be complete', () => {
    expect(m.stage).toBe(61);
    expect(m.status).toBe('VERIFIED');
    expect(m.cases.some((c) => c.id === 'full-dynamic-import-orphan-sweep' && c.status === 'runtime-verified')).toBe(
      true,
    );
    expect(m.cases.some((c) => c.id === 'discord-event-registry-reachability' && c.status === 'runtime-verified')).toBe(true);
    expect(m.cases.some((c) => c.id === 'filesystem-command-runtime-roots' && c.status === 'runtime-verified')).toBe(true);
    expect(m.contracts.nitradoJobs).toMatch(/jobWorker/);
    expect(m.contracts.runtimeReachability).toMatch(/AST-based graph|dynamic imports|src\/events/i);
    expect(m.evidence).toEqual(expect.arrayContaining([
      'tests/security/stage61RuntimeReachabilityArchitecture.test.ts',
      'tests/security/deadCodeLegacyCleanupArchitecture.test.ts',
    ]));
    expect(m.residual).toEqual([]);
    expect(r('tests/security/gesamtaudit2CouplingsArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('keeps membership, economy scope, and incident fail-closed couplings', () => {
    expect(auth).toMatch(/GUILD_MEMBERSHIP_REQUIRED|requireAuth|requireGuildPermission/);
    expect(econ).toContain('requireSafeDashboardEconomyScope');
    expect(incident).toMatch(/operationalActions\s*=\s*\[\s*\]|OPERATIONAL_INCIDENT_ACTIONS/);
  });

  it('keeps Nitrado job, leave/rejoin, and AI runtime↔toolRuntime couplings', () => {
    expect(schema).toContain('model NitradoJob');
    expect(fs.existsSync(path.resolve('src/modules/nitrado/jobWorker.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve('src/events/guildMemberRemove.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve('src/modules/moderation/leaveCleanupWorker.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve('src/modules/moderation/leaveCleanupRejoin.ts'))).toBe(true);
    expect(aiRuntime).toMatch(/toolRuntime|executeTool|runTool/i);
    expect(fs.existsSync(path.resolve('src/modules/ai/toolRuntime.ts'))).toBe(true);
  });
});
