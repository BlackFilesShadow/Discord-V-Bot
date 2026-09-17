import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const legacySource = read('dashboard-ui/src/pages/ServerSlot.tsx');
const v3Source = read('dashboard-ui/src/pages/ServerSlotV3.tsx');
const mainSource = read('dashboard-ui/src/main.tsx');
const architectureCss = read('dashboard-ui/src/slot-page-architecture.css');

const SLOT_KEYS = [
  'settings',
  'whitelist',
  'economy',
  'links',
  'virtual-accounts',
  'bank-casino',
  'killfeed',
  'radar',
] as const;

function expectOrder(source: string, keys: readonly string[]): void {
  let previous = -1;
  for (const key of keys) {
    const index = source.indexOf(`['${key}',`);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('slot dashboard page architecture', () => {
  it('keeps all eight slot functions in the established order in legacy and V3', () => {
    expectOrder(legacySource, SLOT_KEYS);
    expectOrder(v3Source, SLOT_KEYS);
  });

  it('does not change slot route keys or function assignments', () => {
    for (const key of SLOT_KEYS) {
      expect(legacySource).toContain(`'${key}'`);
      expect(v3Source).toContain(`'${key}'`);
    }
    expect(legacySource).toContain("type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'virtual-accounts' | 'bank-casino' | 'killfeed' | 'radar';");
    expect(v3Source).toContain("type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'virtual-accounts' | 'bank-casino' | 'killfeed' | 'radar';");
  });

  it('loads the page architecture layer after the base and vivid themes', () => {
    const vivid = mainSource.indexOf("import './vivid-theme.css';");
    const pageArchitecture = mainSource.indexOf("import './slot-page-architecture.css';");
    expect(vivid).toBeGreaterThanOrEqual(0);
    expect(pageArchitecture).toBeGreaterThan(vivid);
  });

  it('shows the complete slot sidebar as PAGE 2 and removes only the historical internal divider', () => {
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
