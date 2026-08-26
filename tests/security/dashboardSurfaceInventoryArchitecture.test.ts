import fs from 'node:fs';
import path from 'node:path';

type VerificationStatus = 'verified' | 'partial' | 'shell-only' | 'missing';

interface Verification {
  status: VerificationStatus;
  evidence: string[];
}

interface Surface {
  id: string;
  area: string;
  route: string;
  ui: string[];
  api: string[];
  backend: string[];
  db: string[];
  permissions: string[];
  scope: string;
  actions: string[];
  tests: Verification;
  mobile: Verification;
}

interface Inventory {
  schemaVersion: number;
  stage: number;
  inventoriedMainSha: string;
  fieldContract: string[];
  frontendRoutePatterns: string[];
  serverTabs: string[];
  slotTabs: string[];
  botAdminViews: string[];
  devCatalogSlugs: string[];
  devSpecialSlugs: string[];
  ignoredUiModules: Array<{ path: string; reason: string }>;
  surfaces: Surface[];
  serverMounts: string[];
  v2Mounts: string[];
  nonUiHttpSurfaces: Array<{ path: string; classification: string; followUpStages: number[] }>;
  gaps: Array<{ id: string; surfaces: string[]; finding: string; followUpStages: number[] }>;
}

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');
const inventory = JSON.parse(read('docs/dashboard-surface-inventory.json')) as Inventory;

// Stage 23 is immutable historical evidence. Public legal pages were introduced
// deliberately after that inventory and are tracked here as explicit post-stage
// additions instead of rewriting the original inventoriedMainSha evidence.
const POST_STAGE_PUBLIC_PAGES = [
  'dashboard-ui/src/pages/legal/LegalLayout.tsx',
  'dashboard-ui/src/pages/legal/Privacy.tsx',
  'dashboard-ui/src/pages/legal/Terms.tsx',
] as const;
const POST_STAGE_PUBLIC_ROUTES = [
  '<Route path="/legal/privacy" element={<Privacy />} />',
  '<Route path="/legal/terms" element={<Terms />} />',
] as const;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function quotedUnion(source: string, declaration: string): string[] {
  const match = source.match(new RegExp(`type ${declaration} = ([^;]+);`));
  return sortedUnique(match?.[1].match(/'([^']+)'/g)?.map(value => value.slice(1, -1)) ?? []);
}

describe('stage 23 dashboard surface inventory architecture', () => {
  test('keeps one complete, typed record for every stage-23 routed UI surface', () => {
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.stage).toBe(23);
    expect(inventory.inventoriedMainSha).toMatch(/^[a-f0-9]{40}$/);
    expect(inventory.surfaces).toHaveLength(57);
    expect(new Set(inventory.surfaces.map(surface => surface.id)).size).toBe(57);

    const requiredFields = [
      'route', 'ui', 'api', 'backend', 'db', 'permissions', 'scope', 'actions', 'tests', 'mobile',
    ];
    expect(inventory.fieldContract).toEqual(requiredFields);

    for (const surface of inventory.surfaces) {
      expect(surface.id).toMatch(/^[a-z0-9-]+$/);
      expect(surface.area.length).toBeGreaterThan(0);
      expect(surface.route.length).toBeGreaterThan(0);
      for (const field of ['ui', 'api', 'backend', 'db', 'permissions', 'actions'] as const) {
        expect(surface[field].length).toBeGreaterThan(0);
        expect(surface[field].every(value => value.trim().length > 0)).toBe(true);
      }
      expect(surface.scope.length).toBeGreaterThan(0);
      expect(['verified', 'partial', 'missing']).toContain(surface.tests.status);
      expect(['verified', 'partial', 'shell-only', 'missing']).toContain(surface.mobile.status);
      expect(surface.tests.evidence.length).toBeGreaterThan(0);
      expect(surface.mobile.evidence.length).toBeGreaterThan(0);
    }
  });

  test('matches the historical App routes and explicitly gates post-stage public legal routes', () => {
    const app = read('dashboard-ui/src/App.tsx');
    const expectedTopLevel = [
      '/login', '/servers', '/servers/:guildId', '/servers/:guildId/server/:slot', '/bot-admin', '/dev',
    ];
    expect(inventory.frontendRoutePatterns).toEqual(expectedTopLevel);
    for (const route of expectedTopLevel) {
      expect(app).toContain(`path="${route}"`);
    }

    for (const route of POST_STAGE_PUBLIC_ROUTES) expect(app).toContain(route);
    expect(app.indexOf(POST_STAGE_PUBLIC_ROUTES[0])).toBeLessThan(app.indexOf('<Route path="/servers" element={<Protected>'));
    expect(app.indexOf(POST_STAGE_PUBLIC_ROUTES[1])).toBeLessThan(app.indexOf('<Route path="/servers" element={<Protected>'));

    const expectedIds = [
      'public-login',
      'servers-list',
      ...inventory.serverTabs.map(tab => `server-${tab}`),
      ...inventory.slotTabs.map(tab => `slot-${tab}`),
      ...inventory.botAdminViews.map(view => `bot-admin-${view}`),
      'dev-shell',
      ...inventory.devCatalogSlugs.map(slug => `dev-${slug}`),
      ...inventory.devSpecialSlugs.map(slug => `dev-${slug}`),
    ];
    expect(sortedUnique(inventory.surfaces.map(surface => surface.id))).toEqual(sortedUnique(expectedIds));
    expect(app).toContain('<Route path="command-center" element={<CommandCenter />} />');
    expect(app).toContain('<Route path="secure-export" element={<SecureDevExport />} />');
    expect(app).toContain('DEV_TOOL_SLUGS.map');
    expect(app).toContain('<Route key={slug} path={slug} element={<Page />} />');
  });

  test('tracks all live tabs, views, and DEV catalog entries from their source declarations', () => {
    const server = read('dashboard-ui/src/pages/Server.tsx');
    const slot = read('dashboard-ui/src/pages/ServerSlot.tsx');
    const botAdmin = read('dashboard-ui/src/pages/BotAdmin.tsx');
    const devCatalog = read('dashboard-ui/src/lib/devToolsCatalog.ts');

    expect(sortedUnique(inventory.serverTabs)).toEqual(quotedUnion(server, 'Tab'));
    expect(sortedUnique(inventory.slotTabs)).toEqual(quotedUnion(slot, 'Tab'));
    expect(sortedUnique(inventory.botAdminViews)).toEqual(
      sortedUnique(botAdmin.match(/view === '([^']+)'/g)?.map(value => value.match(/'([^']+)'/)?.[1] ?? '') ?? []),
    );
    expect(inventory.devCatalogSlugs).toEqual(
      devCatalog.match(/slug:\s*'([^']+)'/g)?.map(value => value.match(/'([^']+)'/)?.[1] ?? '') ?? [],
    );
    expect(inventory.devSpecialSlugs).toEqual(['command-center', 'secure-export']);
  });

  test('accounts for every routed page module including reviewed post-stage legal pages', () => {
    const pageFiles = fs.readdirSync(path.resolve(root, 'dashboard-ui/src/pages'), { recursive: true })
      .map(value => String(value).replace(/\\/g, '/'))
      .filter(value => value.endsWith('.tsx'))
      .map(value => `dashboard-ui/src/pages/${value}`);
    const coveredPages = inventory.surfaces.flatMap(surface => surface.ui.map(value => value.split('#')[0]));
    const ignoredPages = inventory.ignoredUiModules.map(entry => entry.path);
    expect(sortedUnique([...coveredPages, ...ignoredPages, ...POST_STAGE_PUBLIC_PAGES]).filter(value => value.includes('/pages/')))
      .toEqual(sortedUnique(pageFiles));

    for (const publicPage of POST_STAGE_PUBLIC_PAGES) {
      expect(fs.existsSync(path.resolve(root, publicPage))).toBe(true);
    }
    for (const ignored of inventory.ignoredUiModules) {
      expect(ignored.reason.length).toBeGreaterThan(20);
      expect(fs.existsSync(path.resolve(root, ignored.path))).toBe(true);
    }
    for (const surface of inventory.surfaces) {
      for (const relative of [...surface.ui, ...surface.backend].map(value => value.split('#')[0])) {
        expect(fs.existsSync(path.resolve(root, relative))).toBe(true);
      }
      for (const relative of [...surface.tests.evidence, ...surface.mobile.evidence]) {
        expect(fs.existsSync(path.resolve(root, relative))).toBe(true);
      }
    }
  });

  test('fails closed when an Express dashboard mount is added without inventory coverage', () => {
    const server = read('src/dashboard/server.ts');
    const actualServerMounts = sortedUnique(
      [...server.matchAll(/app\.(?:use|get|post)\(\s*'([^']+)'/g)].map(match => match[1]),
    );
    expect(sortedUnique(inventory.serverMounts)).toEqual(actualServerMounts);

    const v2 = read('src/dashboard/routes/v2.ts');
    const actualV2Mounts = sortedUnique(
      [...v2.matchAll(/v2Router\.use\(\s*'([^']+)'/g)].map(match => match[1]),
    );
    expect(sortedUnique(inventory.v2Mounts)).toEqual(actualV2Mounts);

    const declaredApis = inventory.surfaces.flatMap(surface => surface.api);
    const classifiedNonUi = new Set(inventory.nonUiHttpSurfaces.map(surface => surface.path));
    const uncoveredServerMounts = inventory.serverMounts.filter(mount => (
      !declaredApis.some(api => api === mount || api.startsWith(`${mount}/`)) && !classifiedNonUi.has(mount)
    ));
    expect(uncoveredServerMounts).toEqual([]);

    const uncoveredV2Mounts = inventory.v2Mounts.filter(mount => {
      const absolute = `/api/v2${mount}`;
      return !declaredApis.some(api => api === absolute || api.startsWith(`${absolute}/`) || api.startsWith(`${absolute}?`));
    });
    expect(uncoveredV2Mounts).toEqual([]);
  });

  test('maps every API v2 prefix used by the UI to an inventoried surface', () => {
    const uiFiles = fs.readdirSync(path.resolve(root, 'dashboard-ui/src'), { recursive: true })
      .map(value => path.resolve(root, 'dashboard-ui/src', String(value)))
      .filter(value => /\.tsx?$/.test(value));
    const usedPrefixes = new Set<string>();
    for (const file of uiFiles) {
      for (const match of read(path.relative(root, file)).matchAll(/['"\x60](\/api\/v2\/[A-Za-z0-9_./:-]*)/g)) {
        usedPrefixes.add(match[1].replace(/\/$/, ''));
      }
    }
    const declared = inventory.surfaces
      .flatMap(surface => surface.api)
      .filter(value => value.startsWith('/api/v2/'))
      .map(value => value.replace(/\/$/, ''));
    const missing = [...usedPrefixes]
      .filter(prefix => !declared.some(value => value.startsWith(prefix) || prefix.startsWith(value)));
    expect(sortedUnique(missing)).toEqual([]);
  });

  test('keeps uncovered work explicit and assigned only to the remaining dashboard stages', () => {
    const surfaceIds = new Set(inventory.surfaces.map(surface => surface.id));
    expect(inventory.gaps.length).toBeGreaterThan(0);
    for (const gap of inventory.gaps) {
      expect(gap.id).toMatch(/^DASH-INV-\d{3}$/);
      expect(gap.finding.length).toBeGreaterThan(30);
      expect(gap.surfaces.length).toBeGreaterThan(0);
      expect(gap.surfaces.every(id => surfaceIds.has(id))).toBe(true);
      expect(gap.followUpStages.every(stage => stage >= 24 && stage <= 38)).toBe(true);
    }
    const assignedSurfaceIds = new Set(inventory.gaps.flatMap(gap => gap.surfaces));
    const incompleteSurfaceIds = inventory.surfaces
      .filter(surface => surface.tests.status !== 'verified' || surface.mobile.status !== 'verified')
      .map(surface => surface.id);
    expect(incompleteSurfaceIds.every(id => assignedSurfaceIds.has(id))).toBe(true);
    for (const surface of inventory.nonUiHttpSurfaces) {
      expect(inventory.serverMounts).toContain(surface.path);
      expect(surface.classification.length).toBeGreaterThan(10);
      expect(surface.followUpStages.every(stage => stage >= 24 && stage <= 38)).toBe(true);
    }
  });
});
