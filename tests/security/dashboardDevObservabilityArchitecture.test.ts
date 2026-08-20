import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Dashboard-2E DEV observability architecture', () => {
  const v2 = read('src/dashboard/routes/v2.ts');
  const router = read('src/dashboard/routes/v2/devObservability.ts');
  const observabilityUi = read('dashboard-ui/src/pages/dev/Observability.tsx');
  const auditUi = read('dashboard-ui/src/pages/dev/AuditLogs.tsx');

  test('mountet Observability hinter globaler Developer-Identitaet', () => {
    expect(v2).toContain("v2Router.use('/dev/observability', requireGlobalDeveloperIdentity, devObservabilityRouter);");
  });

  test('validiert aktive DevSession vor dem gemeinsamen Global-Scope-Guard', () => {
    expect(router).toContain('devObservabilityRouter.use(requireDev);');
    expect(router).toContain("import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';");
    expect(router).toMatch(/devObservabilityRouter\.use\(\(req, res, next\) => \{[\s\S]*rejectGlobalOnlyForRestrictedSession\(req, res\)/);
  });

  test('redigiert Live-Logs und Audit-Details vor Ausgabe', () => {
    expect(router).toContain("import { redactAuditDetails } from '../../../utils/auditRedaction';");
    expect(router).toContain('message: redactDiagnosticText(entry.message)');
    expect(router).toContain('meta: redactSerializedMeta(entry.meta)');
    expect(router).toContain('JSON.stringify(redactAuditDetails(JSON.parse(meta)))');
    expect(router).toContain('details: redactAuditDetails(r.details)');
  });

  test('nutzt kanonischen verlustfreien Audit-Cursor statt before', () => {
    expect(router).toContain('decodeAuditCursor(req.query.cursor)');
    expect(router).toContain('auditCursorFilter(cursor)');
    expect(router).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(router).toContain('take: limit + 1');
    expect(router).toContain('encodeAuditCursor({ createdAt: lastVisible.createdAt, id: lastVisible.id })');
    expect(router).toContain('before wird nicht mehr unterstuetzt');
  });

  test('erzwingt sichtbare Fehlerzustaende und mobile Touch-Ziele', () => {
    expect(observabilityUi).toContain('prismaQ.error ? <QueryError');
    expect(observabilityUi).toContain('logsQ.error ? <QueryError');
    expect(observabilityUi).toContain('min-h-11');
    expect(auditUi).toContain('role="alert"');
    expect(auditUi).toContain('min-h-11');
  });

  test('Audit-UI besitzt race-sichere echte Cursor-Pagination', () => {
    expect(auditUi).toContain('nextCursor: string | null');
    expect(auditUi).toContain("params.set('cursor', cursor)");
    expect(auditUi).toContain('entries: [...prev.entries, ...next.entries]');
    expect(auditUi).toContain('appliedFilters.current');
    expect(auditUi).toContain('requestId !== requestSeq.current');
    expect(auditUi).toContain('Mehr laden');
  });
});
