import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const devPageSource = read('dashboard-ui/src/pages/Dev.tsx');
const devPanelSource = read('dashboard-ui/src/components/DevLoginPanel.tsx');
const devSessionSource = read('dashboard-ui/src/lib/devSession.tsx');

describe('Dashboard-2A DEV shell architecture', () => {
  test('DEV password affordance is only rendered for authenticated DEVELOPER accounts', () => {
    expect(devPanelSource).toContain("if (!user || user.role !== 'DEVELOPER') return null;");
  });

  test('server status is confirmed before active DEV tools can render', () => {
    const loadingGate = devPageSource.indexOf('if (dev.loading)');
    const activeGate = devPageSource.indexOf('if (!dev.active)');
    const outlet = devPageSource.indexOf('<Outlet />');

    expect(loadingGate).toBeGreaterThan(-1);
    expect(activeGate).toBeGreaterThan(loadingGate);
    expect(outlet).toBeGreaterThan(activeGate);
  });

  test('every failed status refresh clears optimistic privileged state', () => {
    expect(devSessionSource).toMatch(/catch\s*\{[\s\S]*?setActive\(false\);[\s\S]*?setEligible\(false\);[\s\S]*?setExpiresAt\(null\);[\s\S]*?writeHint\(false\);/);
  });

  test('mobile DEV navigation uses 44px targets and does not nest a button inside a NavLink', () => {
    expect(devPageSource).toContain('min-h-11 md:min-h-9');
    expect(devPageSource).toContain('min-h-11 min-w-11 md:min-h-8 md:min-w-8');
    expect(devPageSource).toContain('h-11 w-11 md:h-8 md:w-8');

    const toolLink = devPageSource.match(/<NavLink to=\{to\}[\s\S]*?<\/NavLink>/)?.[0] ?? '';
    expect(toolLink).not.toContain('<button');
    expect(devPageSource).toMatch(/<\/NavLink>\s*<button[\s\S]*?toggle\(t\.slug\)/);
  });
});
