import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const legacySource = read('dashboard-ui/src/pages/ServerSlot.tsx');
const v3Source = read('dashboard-ui/src/pages/ServerSlotV3.tsx');
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

describe('slot dashboard page architecture', () => {
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

  it('loads the page architecture layer after the base and vivid themes', () => {
    const vivid = mainSource.indexOf("import './vivid-theme.css';");
    const pageArchitecture = mainSource.indexOf("import './slot-page-architecture.css';");
    expect(vivid).toBeGreaterThanOrEqual(0);
    expect(pageArchitecture).toBeGreaterThan(vivid);
  });

  it('shows the complete desktop slot sidebar as PAGE 2 and removes only the historical internal divider', () => {
    expect(architectureCss).toContain("content: 'PAGE 2';");
    expect(architectureCss).not.toContain("content: 'PAGE 1';");
    expect(architectureCss).toContain(".dashboard-sidebar nav[aria-label='Slot-Funktionen'] > p");
    expect(architectureCss).toContain(".dashboard-sidebar nav[aria-label='Slot-Funktionen'] > div.pt-4.mt-3.border-t");
    expect(architectureCss).toContain('border-top-width: 0 !important;');
  });

  it('scopes the correction to desktop slot navigation only', () => {
    expect(architectureCss).toContain('@media (min-width: 768px)');
    expect(architectureCss).toContain("nav[aria-label='Slot-Funktionen']");
    expect(architectureCss).not.toContain("aria-label='Navigation'");
  });
});
