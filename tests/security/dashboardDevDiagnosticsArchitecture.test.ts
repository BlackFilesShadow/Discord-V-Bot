import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const v2Source = read('src/dashboard/routes/v2.ts');
const statusContractSource = read('src/dashboard/routes/v2/devDiagnosticsContract.ts');
const stubsContractSource = read('src/dashboard/routes/v2/devDiagnosticsStubs.ts');
const statusHookSource = read('dashboard-ui/src/lib/useDevStatus.ts');
const databaseUiSource = read('dashboard-ui/src/pages/dev/DatabaseStatus.tsx');
const discordUiSource = read('dashboard-ui/src/pages/dev/DiscordStatus.tsx');
const nitradoUiSource = read('dashboard-ui/src/pages/dev/NitradoStatus.tsx');
const liveUiSource = read('dashboard-ui/src/pages/dev/LiveBotStatus.tsx');

describe('Dashboard-2C DEV diagnostics architecture', () => {
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
    expect(stubsContractSource).toContain("const restrict = req.devSession?.scope.guildIdRestrict ?? null;");
    expect(stubsContractSource).toContain('prisma.gameIdentityLink.count({ where: linkWhere })');
    expect(stubsContractSource).not.toContain('total: linksByGuild.reduce');
  });

  test('client invalidates stale privileged snapshots on any failed diagnostic read', () => {
    expect(statusHookSource).toContain('setData(null);');
    expect(statusHookSource).toContain('setLastFetchedAt(null);');
    expect(statusHookSource).toContain("code === 'DEV_IDENTITY_REQUIRED'");
    expect(statusHookSource).toContain("code === 'DEV_SCOPE_RESTRICTED'");
    expect(statusHookSource).toContain('e.status === 403');
  });

  test('live snapshot is runtime-validated and missing data is never reported as offline', () => {
    expect(liveUiSource).toContain('function asSnapshot(value: unknown): Snapshot | null');
    expect(liveUiSource).toContain("useDevStatus<unknown>('/api/v2/dev/snapshot', 5000)");
    expect(liveUiSource).toContain('Ungültige Snapshot-Antwort. Diagnosewerte wurden verworfen.');
    expect(liveUiSource).toMatch(/snap \? \(snap\.botReady \? 'online' : 'offline'\) : \(loading \? 'lädt…' : 'unbekannt'\)/);
    expect(liveUiSource).toContain('role="alert"');
  });

  test('mobile diagnostic controls retain touch targets and log output cannot widen the page', () => {
    expect(liveUiSource).toContain('min-h-11 min-w-11 sm:min-h-0 sm:min-w-0');
    expect(liveUiSource).toContain('aria-label="Live-Logs durchsuchen"');
    expect(liveUiSource).toContain('className="pl-7 h-11 sm:h-8 text-xs"');
    expect(liveUiSource).toContain('max-w-full overflow-x-hidden overflow-y-auto');
    expect(liveUiSource).toContain('break-all whitespace-pre-wrap min-w-0');
  });

  test('wide core diagnostic tables are contained instead of overflowing the mobile page', () => {
    for (const source of [databaseUiSource, discordUiSource, nitradoUiSource]) {
      expect(source).toContain('overflow-x-auto');
      expect(source).toContain('min-w-0');
    }
    expect(discordUiSource).toContain('statusCode: number | null;');
    expect(discordUiSource).toContain("if (statusCode === null) return 'Offline';");
    expect(databaseUiSource).toContain('migrationsApplied: number | null;');
  });
});
