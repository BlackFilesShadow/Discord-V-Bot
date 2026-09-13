import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Help-/Command-Katalog — Drift-Sicherheitsinvarianten', () => {
  const help = read('src/commands/user/help.ts');
  const inventory = read('src/commands/inventory.ts');
  const upload = read('src/commands/user/upload.ts');

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

  it('haelt das kanonische guild-scoped Discord-Inventar fuer aktive Commands synchron', () => {
    const start = inventory.indexOf('export const SPEC_KEEP_COMMANDS');
    const end = inventory.indexOf('export interface ClassifyInput', start);
    const block = inventory.slice(start, end);

    expect(block).toContain("'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'case', 'download'");
    expect(block).toContain("'register', 'giveaway', 'help', 'leaderboard', 'level', 'poll', 'feedback', 'erinnerung'");
    expect(block).toContain("'deposit', 'faction', 'factions', 'fraktionen', 'join', 'leave'");
    expect(block).toContain("'pay', 'admin-pay', 'add-money', 'remove-money'");
    expect(block).toContain("'virtual-account', 'lottery', 'black-market'");
    expect(block).not.toContain("'upload'");
    expect(upload).toContain('manufacturerOnly: true');
  });

  it('markiert black-market als vorhandenen Dashboard-Ersatz statt als Discord-only Funktion', () => {
    const start = inventory.indexOf('export const DASHBOARD_EXTRA');
    const end = inventory.indexOf('const ADMIN_EXTRA_NAMES', start);
    const block = inventory.slice(start, end);
    expect(block).toContain("'black-market'");
  });
});
