import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Help-/Command-Katalog — Drift-Sicherheitsinvarianten', () => {
  const help = read('src/commands/user/help.ts');
  const inventory = read('src/commands/inventory.ts');

  it('ordnet neue Moderations- und Economy-Funktionen explizit dem richtigen Bereich zu', () => {
    expect(help).toContain("names: new Set(['kick', 'ban', 'mute', 'warn', 'appeal', 'case'])");
    expect(help).toContain("'virtual-account', 'lottery', 'black-market'");
  });

  it('klassifiziert unbekannte sichtbare Commands nicht mehr stillschweigend als Community', () => {
    expect(help).toContain("id: 'other'");
    expect(help).toContain("label: 'Weitere Funktionen'");
    expect(help).toContain("CATEGORIES.find(category => category.id === 'other')!");
    expect(help).not.toContain('?? CATEGORIES[CATEGORIES.length - 1];');
  });

  it('macht die explizite Fallback-Kategorie auch direkt im Help-Selector erreichbar', () => {
    expect(help).toContain("type HelpCategory = 'overview' | 'moderation' | 'nitrado' | 'economy' | 'manufacturer' | 'community' | 'other';");
    expect(help).toContain("{ name: 'Weitere Funktionen', value: 'other' }");
  });

  it('haelt das kanonische Discord-Inventar fuer case und black-market synchron', () => {
    expect(inventory).toContain("'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'case', 'download', 'upload'");
    expect(inventory).toContain("'virtual-account', 'lottery', 'black-market'");
  });

  it('markiert black-market als vorhandenen Dashboard-Ersatz statt als Discord-only Funktion', () => {
    const start = inventory.indexOf('export const DASHBOARD_EXTRA');
    const end = inventory.indexOf('const ADMIN_EXTRA_NAMES', start);
    const block = inventory.slice(start, end);
    expect(block).toContain("'black-market'");
  });
});
