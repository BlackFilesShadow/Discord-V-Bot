import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dead-code-legacy-cleanup-matrix.json')) as {
  stage: number;
  status: string;
  basedOnMainSha: string;
  decision: string;
  cases: Array<{ id: string; status: string }>;
  contracts: Record<string, string>;
  residual: string[];
};
const coupling = JSON.parse(r('docs/audit/structure-coupling-map.json')) as {
  httpMounts?: { evidenceLevel?: string };
  bootstrap?: { indexStarts?: string[]; nitradoRuntimeStarts?: string[] };
  chains?: { nitradoWhitelistBan?: { evidenceLevel?: string; jobOperations?: string[] } };
};
const pkg = JSON.parse(r('package.json')) as { dependencies?: Record<string, string> };

describe('Stage 57 dead code legacy cleanup', () => {
  it('marks current-main cleanup analysis VERIFIED only with dynamic-coupling evidence', () => {
    expect(m.stage).toBe(57);
    expect(m.status).toBe('VERIFIED');
    expect(m.basedOnMainSha).toBe('425cf4d7b70a9e417d1c6a6a9622e6330f9ceea9');
    expect(m.decision).toMatch(/analysis is complete/i);
    expect(m.contracts.proofRequired).toMatch(/dynamic imports|filesystem command loading|workers|AI tools|Nitrado jobs/i);
    expect(m.residual).toEqual([]);
    expect(m.cases.map((c) => c.id)).toEqual(expect.arrayContaining([
      'dynamic-import-reachability',
      'filesystem-command-loader-reachability',
      'discord-dispatch-reachability',
      'passport-stack-already-removed',
      'ai-tool-registry-intact',
      'nitrado-runtime-worker-chain-intact',
      'audited-coupling-map-crosscheck',
      'no-additional-safe-mass-delete',
    ]));
    expect(r('tests/security/deadCodeLegacyCleanupArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('proves runtime reachability beyond a static import graph', () => {
    const index = r('src/index.ts');
    const commandHandler = r('src/commands/handler.ts');
    const interactions = r('src/events/interactionCreate.ts');

    expect(index).toContain('registerBotEventsSafely(client, events)');
    expect(index).toContain('startNitradoRuntime(client)');
    expect(index).toContain('startAiBackgroundLoops(client)');
    expect(index).toMatch(/await import\('\.\/modules\/ai\/guildAwareness\.js'\)/);

    expect(commandHandler).toContain('fs.readdirSync(dir)');
    expect(commandHandler).toContain('require(path.join(dir, file))');
    expect(commandHandler).toContain("path.join(__dirname, 'user')");
    expect(commandHandler).toContain("path.join(__dirname, 'admin')");
    expect(commandHandler).toContain("path.join(__dirname, 'developer')");
    expect(commandHandler).toContain("path.join(__dirname, 'dashboard')");

    expect(interactions).toContain("await import('../commands/user/feedback.js')");
    expect(interactions).toContain("await import('../modules/tickets/ticketSystem.js')");
    expect(interactions).toContain("await import('../modules/economy/lottery.js')");
    expect(interactions).toContain("await import('../modules/selfrole/selfRoleMenu.js')");
    expect(interactions).toContain("await import('../modules/whitelist/whitelistApprovalButton.js')");
  });

  it('pins AI registry and Nitrado worker chains as live runtime surfaces', () => {
    const ai = r('src/modules/ai/toolRuntime.ts');
    const nitradoRuntime = r('src/modules/nitrado/runtime.ts');
    const worker = r('src/modules/nitrado/jobWorker.ts');

    expect(ai).toContain('function registerProductionTools(executor: AiToolExecutor)');
    expect(ai).toContain('registerProductionTools(executor)');
    expect(ai).toContain('export async function executeProductionAiTool');
    expect(ai).toContain("name: 'nitrado.connection.status'");
    expect(ai).toContain("name: 'ai.tools.catalog'");

    expect(nitradoRuntime).toContain('startNitradoJobWorker()');
    expect(nitradoRuntime).toContain('await drainAndStopJobWorker()');
    expect(nitradoRuntime).toContain('startAdmLiveSyncCron()');
    expect(nitradoRuntime).toContain('startGameplayFeedRuntime()');

    for (const op of [
      'WHITELIST_ADD',
      'WHITELIST_REMOVE',
      'SERVER_BAN_ADD',
      'SERVER_BAN_REMOVE',
      'KEEPALIVE',
      'DOWNLOAD_ADM',
      'RESTART_IF_DOWN',
    ]) {
      expect(worker).toContain(`'${op}'`);
    }
  });

  it('crosschecks audited coupling-map runtime evidence and keeps proven removals removed', () => {
    expect(coupling.httpMounts?.evidenceLevel).toBe('runtime_code');
    expect(coupling.bootstrap?.indexStarts).toEqual(expect.arrayContaining([
      'startDashboard',
      'startNitradoRuntime',
      'startAiBackgroundLoops on clientReady',
    ]));
    expect(coupling.bootstrap?.nitradoRuntimeStarts).toEqual(expect.arrayContaining([
      'startNitradoJobWorker',
      'startAdmLiveSyncCron',
      'startGameplayFeedRuntime',
    ]));
    expect(coupling.chains?.nitradoWhitelistBan?.evidenceLevel).toBe('runtime_code');
    expect(coupling.chains?.nitradoWhitelistBan?.jobOperations).toEqual(expect.arrayContaining([
      'WHITELIST_ADD',
      'SERVER_BAN_ADD',
      'DOWNLOAD_ADM',
    ]));

    expect(pkg.dependencies?.passport).toBeUndefined();
    expect(pkg.dependencies?.['passport-discord']).toBeUndefined();
    expect(fs.existsSync(path.resolve('src/modules/ai/toolRuntime.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve('src/modules/nitrado/jobWorker.ts'))).toBe(true);
  });
});
