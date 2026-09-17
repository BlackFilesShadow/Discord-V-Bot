import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const serverSource = read('dashboard-ui/src/pages/Server.tsx');
const legacySource = read('dashboard-ui/src/pages/ServerSlot.tsx');
const v3Source = read('dashboard-ui/src/pages/ServerSlotV3.tsx');
const shellSource = read('dashboard-ui/src/components/Shell.tsx');
const mainSource = read('dashboard-ui/src/main.tsx');
const architectureCss = read('dashboard-ui/src/slot-page-architecture.css');

const SLOT_ENTRIES = [
  "['settings', 'Settings', Settings]",
  "['whitelist', 'Whitelist', Shield]",
  "['economy', 'Economy', Coins]",
  "['links', 'Economy-Links', LinkIcon]",
  "['virtual-accounts', 'Virtuelle Konten', Banknote]",
  "['bank-casino', 'Bank und Casino Funktionen', Dice5]",
  "['killfeed', 'Killfeed & ADM', Crosshair]",
  "['radar', 'Zonenradar', MapPinned]",
] as const;

function expectOrder(source: string, entries: readonly string[]): void {
  let previous = -1;
  for (const entry of entries) {
    const index = source.indexOf(entry);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function between(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('dashboard page architecture', () => {
  it('keeps all eight slot functions in the established order in legacy and V3 navigation definitions', () => {
    const legacyNavigation = between(legacySource, 'const pageOneTabs = [', 'const sidebarButton =');
    const v3Navigation = between(v3Source, 'const NAV:', 'const ECONOMY_SECTIONS');
    expectOrder(legacyNavigation, SLOT_ENTRIES);
    expectOrder(v3Navigation, SLOT_ENTRIES);
  });

  it('does not change slot route keys or function assignments', () => {
    const tabType = "type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'virtual-accounts' | 'bank-casino' | 'killfeed' | 'radar';";
    expect(legacySource).toContain(tabType);
    expect(v3Source).toContain(tabType);
    for (const entry of SLOT_ENTRIES) {
      expect(legacySource).toContain(entry);
      expect(v3Source).toContain(entry);
    }
  });

  it('keeps the existing semantic navigation contracts for Page 1 and Page 2', () => {
    expect(serverSource).toContain('aria-label="Server-Bereiche"');
    expect(legacySource).toContain('aria-label="Slot-Funktionen"');
    expect(v3Source).toContain('aria-label="Slot-Funktionen"');
  });

  it('exposes the architecture level explicitly on the shared dashboard shell', () => {
    expect(shellSource).toContain("let dashboardPage: '1' | '2' | undefined;");
    expect(shellSource).toContain("if (serverSlotMatch) dashboardPage = '2';");
    expect(shellSource).toContain("else if (/^\\/servers\\/[^/]+\\/?$/.test(loc.pathname)) dashboardPage = '1';");
    expect(shellSource).toContain('data-dashboard-page={dashboardPage}');
  });

  it('loads the page architecture layer after the base and vivid themes', () => {
    const vivid = mainSource.indexOf("import './vivid-theme.css';");
    const pageArchitecture = mainSource.indexOf("import './slot-page-architecture.css';");
    expect(vivid).toBeGreaterThanOrEqual(0);
    expect(pageArchitecture).toBeGreaterThan(vivid);
  });

  it('renders Page 1 and Page 2 as distinct visual architecture layers', () => {
    expect(architectureCss).toContain(".dashboard-shell[data-dashboard-page='1']");
    expect(architectureCss).toContain(".dashboard-shell[data-dashboard-page='2']");
    expect(architectureCss).toContain("content: 'PAGE 1 · SERVER-/GUILD-EBENE';");
    expect(architectureCss).toContain("content: 'PAGE 2 · NITRADO-SLOT-EBENE';");
    expect(architectureCss).toContain("--dashboard-page-color: var(--color-accent);");
    expect(architectureCss).toContain("--dashboard-page-color: var(--color-info);");
  });

  it('labels both desktop sidebars while removing only the historical internal Page 2 divider', () => {
    expect(architectureCss).toContain("nav[aria-label='Server-Bereiche']::before");
    expect(architectureCss).toContain("nav[aria-label='Slot-Funktionen']::before");
    expect(architectureCss).toContain("content: 'PAGE 1 · SERVER-EBENE';");
    expect(architectureCss).toContain("content: 'PAGE 2 · SLOT-EBENE';");
    expect(architectureCss).toContain("nav[aria-label='Slot-Funktionen'] > p");
    expect(architectureCss).toContain("nav[aria-label='Slot-Funktionen'] > div.pt-4.mt-3.border-t");
    expect(architectureCss).toContain('border-top-width: 0 !important;');
  });

  it('keeps the architecture layer presentation-only', () => {
    const runtimeCss = architectureCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(runtimeCss).not.toContain('/api/');
    expect(runtimeCss).not.toContain('fetch(');
    expect(runtimeCss).not.toContain('mutation');
    expect(runtimeCss).not.toContain('permission');
  });
});
