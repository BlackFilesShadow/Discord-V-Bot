import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Dashboard-2C DEV diagnostics architecture', () => {
  const hook = read('dashboard-ui/src/lib/useDevStatus.ts');
  const live = read('dashboard-ui/src/pages/dev/LiveBotStatus.tsx');
  const v2Source = read('src/dashboard/routes/v2.ts');
  const statusContractSource = read('src/dashboard/routes/v2/devDiagnosticsContract.ts');
  const stubsContractSource = read('src/dashboard/routes/v2/devDiagnosticsStubs.ts');
  const databaseUiSource = read('dashboard-ui/src/pages/dev/DatabaseStatus.tsx');
  const discordUiSource = read('dashboard-ui/src/pages/dev/DiscordStatus.tsx');
  const nitradoUiSource = read('dashboard-ui/src/pages/dev/NitradoStatus.tsx');

  test('canonical diagnostics adapters are mounted before legacy status/stub routers', () => {
    expect(v2Source).toContain("import { devDiagnosticsContractRouter } from './v2/devDiagnosticsContract';");
    expect(v2Source).toContain("import { devDiagnosticsStubsRouter } from './v2/devDiagnosticsStubs';");
    expect(v2Source).toContain("v2Router.use('/dev/status', requireGlobalDeveloperIdentity, devDiagnosticsContractRouter, devStatusRouter);");
    expect(v2Source).toContain("v2Router.use('/dev/stubs', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devDiagnosticsStubsRouter, devStubsRouter);");
  });

  test('retrieval debugger is strictly typed and fenced by guildIdRestrict', () => {
    expect(statusContractSource).toContain("typeof record.guildId !== 'string'");
    expect(statusContractSource).toContain("typeof record.question !== 'string'");
    expect(statusContractSource).toContain("typeof record.limit !== 'number'");
    expect(statusContractSource).toContain('Number.isInteger(record.limit)');
    expect(statusContractSource).toContain('const restrict = req.devSession?.scope.guildIdRestrict ?? null;');
    expect(statusContractSource).toContain("code: 'DEV_SCOPE_RESTRICTED'");
  });

  test('diagnostic free text is redacted and ambiguous global reads fail closed when scoped', () => {
    expect(statusContractSource).toContain("import { redactAuditDetails } from '../../../utils/auditRedaction';");
    expect(statusContractSource).toContain("if (path === '/nitrado')");
    expect(statusContractSource).toContain("if (path === '/adm')");
    expect(statusContractSource).toContain("if (path === '/ai-providers')");
    expect(stubsContractSource).toContain("import { redactAuditDetails } from '../../../utils/auditRedaction';");
    expect(stubsContractSource).toContain("devDiagnosticsStubsRouter.get('/errors'");
    expect(stubsContractSource).toContain("devDiagnosticsStubsRouter.get('/security'");
    expect(stubsContractSource).toContain('rejectGlobalOnlyForRestrictedSession(req, res)');
  });

  test('sync diagnostics preserve exact guild scope and use a real total count', () => {
    expect(stubsContractSource).toContain('const restrict = req.devSession?.scope.guildIdRestrict ?? null;');
    expect(stubsContractSource).toContain('prisma.gameIdentityLink.count({ where: linkWhere })');
    expect(stubsContractSource).not.toContain('total: linksByGuild.reduce');
  });

  test('polling invalidates stale privileged data and stops on structural auth/scope loss', () => {
    expect(hook).toMatch(/\.catch\(e => \{[\s\S]*setData\(null\);[\s\S]*setLastFetchedAt\(null\);[\s\S]*setError\(/);
    expect(hook).toContain("code === 'DEV_LOGIN_REQUIRED'");
    expect(hook).toContain("code === 'DEV_MFA_REQUIRED'");
    expect(hook).toContain("code === 'DEV_IP_DENIED'");
    expect(hook).toContain("code === 'DEV_IDENTITY_REQUIRED'");
    expect(hook).toContain("code === 'DEV_SCOPE_RESTRICTED'");
    expect(hook).toContain('setStopped(true)');
  });

  test('live snapshot is runtime-validated and missing data is never reported as offline', () => {
    expect(live).toContain('function asSnapshot(value: unknown): Snapshot | null');
    expect(live).toContain("useDevStatus<unknown>('/api/v2/dev/snapshot', 5000)");
    expect(live).toContain('Ungültige Snapshot-Antwort. Diagnosewerte wurden verworfen.');
    expect(live).toMatch(/snap \? \(snap\.botReady \? 'online' : 'offline'\) : \(loading \? 'lädt…' : 'unbekannt'\)/);
    expect(live).toContain('role="alert"');
  });

  test('core diagnostic UIs contain wide data and retain explicit mobile touch guards', () => {
    for (const source of [databaseUiSource, discordUiSource, nitradoUiSource]) {
      expect(source).toContain('overflow-x-auto');
      expect(source).toContain('min-w-0');
    }
    expect(discordUiSource).toContain('statusCode: number | null;');
    expect(discordUiSource).toContain("if (statusCode === null) return 'Offline';");
    expect(databaseUiSource).toContain('migrationsApplied: number | null;');
    expect(live).toContain('min-h-11 min-w-11 sm:min-h-0 sm:min-w-0');
    expect(live).toContain('aria-label="Live-Logs durchsuchen"');
    expect(live).toContain('className="pl-7 h-11 sm:h-8 text-xs"');
    expect(live).toContain('max-w-full overflow-x-hidden overflow-y-auto');
    expect(live).toContain('break-all whitespace-pre-wrap min-w-0');
  });
});
