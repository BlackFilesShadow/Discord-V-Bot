import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 58 full user journey architecture', () => {
  it('pins the ordered journey to current main without overstating live Discord proof', () => {
    const m = JSON.parse(read('docs/full-user-journey-e2e-matrix.json')) as {
      stage: number;
      status: string;
      basedOnMainSha: string;
      orchestration: { ordered: string[]; chainModules: string[] };
      contracts: Record<string, string>;
      residual: string[];
    };

    expect(m.stage).toBe(58);
    expect(m.status).toBe('PARTIAL');
    expect(m.basedOnMainSha).toBe('fa2ce23df33a5f712df4656d261ab93aa75066a8');
    expect(m.orchestration.ordered[0]).toBe('join');
    expect(m.orchestration.ordered.at(-1)).toBe('rejoin-fresh-state');
    expect(m.orchestration.ordered).toEqual(expect.arrayContaining([
      'whitelist',
      'economy',
      'ai-interaction',
      'nitrado-read',
      'dashboard-login',
      'admin-action',
      'audit-log',
      'leave',
      'cleanup',
    ]));
    expect(m.contracts.currentMainBinding).toContain('fa2ce23df33a5f712df4656d261ab93aa75066a8');
    expect(m.contracts.residualLiveDiscord).toMatch(/live|staging|gateway|OAuth/i);
    expect(m.residual.join(' ')).toMatch(/real tokens|live|staging|Discord/i);
  });

  it('keeps every deletion-sensitive journey module present and the leave/rejoin ordering guarded', () => {
    const m = JSON.parse(read('docs/full-user-journey-e2e-matrix.json')) as {
      orchestration: { chainModules: string[] };
    };

    for (const file of m.orchestration.chainModules) {
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }

    const remove = read('src/events/guildMemberRemove.ts');
    const add = read('src/events/guildMemberAdd.ts');
    const rejoin = read('src/modules/moderation/leaveCleanupRejoin.ts');
    const worker = read('src/modules/moderation/leaveCleanupWorker.ts');

    expect(remove).toMatch(/joinedAt|updatedAt|CAS|generation/i);
    expect(add).toMatch(/leaveCleanup|rejoin|cleanup/i);
    expect(rejoin.length).toBeGreaterThan(100);
    expect(worker.length).toBeGreaterThan(100);
    expect(read('tests/security/fullUserJourneyStage58Architecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });
});
