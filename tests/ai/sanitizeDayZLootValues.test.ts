/**
 * Anti-Halluzinations-Sanitizer fuer DayZ-Loot-Werte.
 *
 * Verifiziert, dass nominal/min/max-Werte > 25 IMMER deterministisch auf
 * Vanilla-Defaults (15/8/20) zurueckgesetzt werden — sowohl als XML-
 * Attribute, XML-Elemente als auch in Markdown-Tabellen.
 */
import { sanitizeDayZLootValues, looksLikeDayZLootContent } from '../../src/modules/ai/nitradoHelp';

describe('sanitizeDayZLootValues', () => {
  it('schreibt unrealistische XML-Attribute auf Vanilla-Defaults um', () => {
    const r = sanitizeDayZLootValues('Setze nominal="70" und min="60" und max="150".');
    expect(r.text).toContain('nominal="15"');
    expect(r.text).toContain('min="8"');
    expect(r.text).toContain('max="20"');
    expect(r.text).not.toMatch(/="70"|="60"|="150"/);
    expect(r.changes).toHaveLength(3);
  });

  it('laesst Werte <= 25 unveraendert', () => {
    const inp = 'nominal="15" min="8" max="20"';
    const r = sanitizeDayZLootValues(inp);
    expect(r.text).toBe(inp);
    expect(r.changes).toEqual([]);
  });

  it('rewrites Element-Stil <nominal>200</nominal>', () => {
    const r = sanitizeDayZLootValues('<type name="M4A1"><nominal>200</nominal><min>100</min></type>');
    expect(r.text).toContain('<nominal>15</nominal>');
    expect(r.text).toContain('<min>8</min>');
    expect(r.changes.length).toBeGreaterThanOrEqual(2);
  });

  it('rewrites Markdown-Tabellen-Zellen', () => {
    const inp = [
      '| Item | nominal | min | max |',
      '|------|---------|-----|-----|',
      '| M4A1 | 70 | 60 | 150 |',
    ].join('\n');
    const r = sanitizeDayZLootValues(inp);
    expect(r.text).toContain('| 15 |');
    expect(r.text).toContain('| 8 |');
    expect(r.text).toContain('| 20 |');
    expect(r.text).not.toMatch(/\b(70|60|150)\b/);
    expect(r.changes.length).toBeGreaterThanOrEqual(3);
  });

  it('liefert leeres changes-Array bei leerem Input', () => {
    expect(sanitizeDayZLootValues('').changes).toEqual([]);
  });

  it('verschont nicht-Loot-Zahlen (z.B. respawn=300)', () => {
    const r = sanitizeDayZLootValues('respawn="300" lifetime="14400"');
    expect(r.changes).toEqual([]);
    expect(r.text).toBe('respawn="300" lifetime="14400"');
  });
});

describe('looksLikeDayZLootContent', () => {
  it('matched bei nominal/min/max-Attributen', () => {
    expect(looksLikeDayZLootContent('Setze nominal="70".')).toBe(true);
  });
  it('matched bei lootcategories.xml', () => {
    expect(looksLikeDayZLootContent('In lootcategories.xml kannst du …')).toBe(true);
  });
  it('matched NICHT bei beliebigem Text', () => {
    expect(looksLikeDayZLootContent('Hallo Welt')).toBe(false);
  });
});
