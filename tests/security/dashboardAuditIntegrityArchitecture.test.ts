import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const routeSource = read('src/dashboard/routes/v2/audit.ts');
const contractSource = read('src/dashboard/routes/v2/auditContract.ts');
const uiSource = read('dashboard-ui/src/pages/Server.tsx');
const loggerSource = read('src/utils/logger.ts');
const redactionSource = read('src/utils/auditRedaction.ts');
const schemaSource = read('prisma/schema.prisma');
const migrationSource = read('prisma/migrations/20260820060000_audit_log_cursor_indexes/migration.sql');

describe('Dashboard-1W audit architecture', () => {
  test('audit HTTP surfaces stay Owner-only and reject the lossy timestamp cursor', () => {
    expect(routeSource).toContain("auditRouter.get('/', requireGuildOwner");
    expect(routeSource).toContain("auditRouter.get('/categories', requireGuildOwner");
    expect(routeSource).toContain('if (req.query.before !== undefined)');
    expect(routeSource).toContain('parseAuditLimit(req.query.limit)');
    expect(routeSource).toContain('parseAuditCategory(req.query.category)');
    expect(routeSource).toContain('parseAuditAction(req.query.action)');
    expect(routeSource).toContain('decodeAuditCursor(req.query.cursor)');
  });

  test('pagination uses one deterministic createdAt+id contract and a real limit+1 probe', () => {
    expect(routeSource).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(routeSource).toContain('take: limit + 1');
    expect(routeSource).toContain('const hasMore = rows.length > limit');
    expect(routeSource).toContain('const visibleRows = rows.slice(0, limit)');
    expect(routeSource).toContain('encodeAuditCursor({ createdAt: lastVisible.createdAt, id: lastVisible.id })');
    expect(routeSource).toContain('nextCursor');
    expect(contractSource).toContain("CURSOR_PREFIX = 'v1.'");
    expect(contractSource).toContain('{ createdAt: cursor.createdAt, id: { lt: cursor.id } }');
  });

  test('UI mirrors Owner-only auth and does not maintain a second mutable cursor/page truth', () => {
    expect(uiSource).toContain("{ key: 'audit', label: 'Audit-Log', icon: Activity, ownerOnly: true }");
    expect(uiSource).toContain("tab === 'audit' && guildId && isOwner && <AuditTab guildId={guildId} />");
    expect(uiSource).toContain('useInfiniteQuery');
    expect(uiSource).toMatch(
      /getNextPageParam:\s*\(?lastPage\)?\s*=>\s*lastPage\.nextCursor\s*\?\?\s*undefined/,
    );
    expect(uiSource).toContain("queryKey: ['audit', guildId, category, appliedAction]");
    expect(uiSource).not.toContain('const [pages, setPages]');
    expect(uiSource).not.toContain("qs.set('before', cursor)");
  });

  test('audit details are redacted both before DB persistence and on legacy reads', () => {
    expect(routeSource).toContain('details: redactAuditDetails(r.details)');
    expect(loggerSource).toContain("from './auditRedaction'");
    expect(loggerSource).toContain('details: redactAuditDetails(meta.details ?? null) as never');
    expect(loggerSource).toContain("requireRuntime('../database/prisma')");
    expect(loggerSource).not.toContain("import('../database/prisma.js')");
    expect(redactionSource).toContain('.replace(AUTH_HEADER_RE');
    expect(redactionSource.indexOf('.replace(AUTH_HEADER_RE')).toBeLessThan(
      redactionSource.indexOf('return redactText(secretRedacted)'),
    );
  });

  test('schema and migration carry guild-scoped cursor/category indexes', () => {
    expect(schemaSource).toContain('@@index([guildId, createdAt, id])');
    expect(schemaSource).toContain('@@index([guildId, category, createdAt, id])');
    expect(migrationSource).toContain('"AuditLog_guildId_createdAt_id_idx"');
    expect(migrationSource).toContain('"AuditLog_guildId_category_createdAt_id_idx"');
  });
});
