import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const devPageSource = read('dashboard-ui/src/pages/Dev.tsx');
const devPanelSource = read('dashboard-ui/src/components/DevLoginPanel.tsx');
const devSessionSource = read('dashboard-ui/src/lib/devSession.tsx');
const pinnedSource = read('dashboard-ui/src/components/dev/PinnedToolsRow.tsx');

describe('Dashboard-2A DEV shell architecture', () => {
  test('DEV password affordance requires role and server-confirmed GlobalDeveloperIdentity', () => {
    expect(devPanelSource).toContain("if (!user || user.role !== 'DEVELOPER') return null;");
    expect(devPanelSource).toContain('const { active, eligible, loading, login, logout, expiresAt } = useDevSession();');
    expect(devPanelSource).toContain('if (!eligible) return null;');
  });

  test('server identity/status is confirmed before active DEV tools can render', () => {
    const loadingGate = devPageSource.indexOf('if (dev.loading)');
    const eligibleGate = devPageSource.indexOf('if (!dev.eligible)');
    const activeGate = devPageSource.indexOf('if (!dev.active)');
    const outlet = devPageSource.indexOf('<Outlet />');

    expect(loadingGate).toBeGreaterThan(-1);
    expect(eligibleGate).toBeGreaterThan(loadingGate);
    expect(activeGate).toBeGreaterThan(eligibleGate);
    expect(outlet).toBeGreaterThan(activeGate);
  });

  test('privileged client state starts fail-closed and every failed refresh clears it', () => {
    expect(devSessionSource).toContain('const [active, setActive] = useState<boolean>(false);');
    expect(devSessionSource).not.toContain('useState<boolean>(readHint())');
    expect(devSessionSource).not.toContain('function readHint');
    expect(devSessionSource).toMatch(/catch\s*\{[\s\S]*?setActive\(false\);[\s\S]*?setEligible\(false\);[\s\S]*?setExpiresAt\(null\);[\s\S]*?clearLegacyHint\(\);/);
  });

  test('mobile DEV navigation uses 44px targets and does not nest action buttons inside links', () => {
    expect(devPageSource).toContain('min-h-11 md:min-h-9');
    expect(devPageSource).toContain('min-h-11 min-w-11 md:min-h-8 md:min-w-8');
    expect(devPageSource).toContain('h-11 w-11 md:h-8 md:w-8');
    expect(pinnedSource).toContain('min-h-11 md:min-h-8');
    expect(pinnedSource).toContain('min-h-11 min-w-11 md:min-h-8 md:min-w-8');

    const toolLink = devPageSource.match(/<NavLink to=\{to\}[\s\S]*?<\/NavLink>/)?.[0] ?? '';
    const pinnedLink = pinnedSource.match(/<Link[\s\S]*?<\/Link>/)?.[0] ?? '';
    expect(toolLink).not.toContain('<button');
    expect(pinnedLink).not.toContain('<button');
    expect(devPageSource).toMatch(/<\/NavLink>\s*<button[\s\S]*?toggle\(t\.slug\)/);
    expect(pinnedSource).toMatch(/<\/Link>\s*<button[\s\S]*?toggle\(slug\)/);
  });
});
