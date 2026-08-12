import {
  sanitizeDayZLootValues,
  looksLikeDayZLootContent,
} from '../../src/modules/ai/nitradoHelp';

describe('DayZ loot output grounding', () => {
  it('veraendert nominal/min/max-Werte nicht allein wegen ihrer Hoehe', () => {
    const input = 'nominal="120" min="95" max="250"';
    const r = sanitizeDayZLootValues(input);
    expect(r.text).toBe(input);
    expect(r.changes).toEqual([]);
  });

  it('veraendert auch XML-Elementwerte >25 nicht', () => {
    const input = '<nominal>150</nominal><min>140</min>';
    expect(sanitizeDayZLootValues(input)).toEqual({ text: input, changes: [] });
  });

  it('erkennt DayZ-Loot-Kontext weiterhin', () => {
    expect(looksLikeDayZLootContent('Setze nominal="70" in types.xml.')).toBe(true);
    expect(looksLikeDayZLootContent('Hallo Welt')).toBe(false);
  });
});
