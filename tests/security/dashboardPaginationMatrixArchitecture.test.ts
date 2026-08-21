import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

interface PaginationList {
  id: string;
  surface: string;
  httpMethod: string;
  route: string;
  mechanism: string;
  orderBy: string;
  tieBreaker: string;
  limitPlusOne: boolean | string;
  hasMore: boolean | string;
  nextCursor: string;
  searchFilter: string;
  scope: string;
  legacyBefore: string;
  ui: string;
  status: string;
  tests: string;
}

interface PaginationMatrix {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  contracts: Record<string, string>;
  lists: PaginationList[];
}

const matrix = JSON.parse(read('docs/dashboard-pagination-matrix.json')) as PaginationMatrix;
const botAdmin = read('src/dashboard/routes/v2/botAdmin.ts');
const auditRoute = read('src/dashboard/routes/v2/audit.ts');
const devObs = read('src/dashboard/routes/v2/devObservability.ts');
const tickets = read('src/dashboard/routes/v2/tickets.ts');
const whitelist = read('src/dashboard/routes/v2/whitelist.ts');
const secureExport = read('src/dashboard/routes/v2/devSecureExport.ts');
const auditExport = read('src/dashboard/routes/v2/botAdminAuditExport.ts');
const auditUi = read('dashboard-ui/src/pages/Server.tsx');
const devAuditUi = read('dashboard-ui/src/pages/dev/AuditLogs.tsx');

const required: Array<keyof PaginationList> = [
  'id', 'surface', 'httpMethod', 'route', 'mechanism', 'orderBy', 'tieBreaker',
  'limitPlusOne', 'hasMore', 'nextCursor', 'searchFilter', 'scope', 'legacyBefore',
  'ui', 'status', 'tests',
];

describe('Stage 28 dashboard pagination / search / filter / cursor matrix', () => {
  it('documents inventory rows with required fields and unique ids', () => {
    expect(matrix.stage).toBe(28);
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.lists.length).toBeGreaterThanOrEqual(12);
    const ids = new Set<string>();
    for (const row of matrix.lists) {
      for (const key of required) {
        expect(String(row[key] ?? '').trim()).not.toBe('');
      }
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
  });

  it('keeps guild + DEV audit on canonical limit+1 keyset cursor', () => {
    expect(auditRoute).toContain('take: limit + 1');
    expect(auditRoute).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(auditRoute).toContain('before wird nicht mehr unterstuetzt');
    expect(devObs).toContain('take: limit + 1');
    expect(devObs).toContain('decodeAuditCursor(req.query.cursor)');
    expect(devObs).toContain('before wird nicht mehr unterstuetzt');
    expect(auditUi).toContain('useInfiniteQuery');
    expect(auditUi).toMatch(/getNextPageParam:\s*\(?lastPage\)?\s*=>\s*lastPage\.nextCursor/);
    expect(devAuditUi).toContain('appliedFilters');
    expect(devAuditUi).toContain('requestSeq');
    expect(devAuditUi).toContain('append');
  });

  it('stabilizes bot-admin offset lists with tie-breaker order and hasMore metadata', () => {
    expect(botAdmin).toContain('STABLE_CREATED_DESC');
    expect(botAdmin).toContain('parsePageOrReject');
    expect(botAdmin).toContain('offsetPageMeta');
    expect(botAdmin).toContain("orderBy: STABLE_CREATED_DESC");
    expect(botAdmin).not.toMatch(/parsePage\(req\)/);
    // Offset list handlers must not fall back to createdAt-only ordering.
    expect(botAdmin).not.toMatch(/findMany\(\{[^}]*orderBy:\s*\{\s*createdAt:\s*'desc'\s*\}[^}]*skip,/s);
    for (const route of ['/appeals', '/feedback', '/packages', '/users', '/tickets', '/validate']) {
      expect(botAdmin).toContain(`'${route}'`);
    }
    expect(botAdmin).toContain('hasMore: page * pageSize < total');
  });

  it('exposes hasMore on hard-cap guild ticket instances and whitelist windows', () => {
    expect(tickets).toContain('take: limit + 1');
    expect(tickets).toContain("orderBy: [{ openedAt: 'desc' }, { id: 'desc' }]");
    expect(tickets).toContain('const hasMore = rows.length > limit');
    expect(whitelist).toContain('take: limit + 1');
    expect(whitelist).toContain("orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }]");
    expect(whitelist).toContain('const hasMore = rows.length > limit');
  });

  it('keeps streaming exports on createdAt+id order with id cursor pages', () => {
    expect(secureExport).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(secureExport).toContain('cursor: { id: cursor }');
    expect(auditExport).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(auditExport).toContain('cursor: { id: cursor }');
  });
});
