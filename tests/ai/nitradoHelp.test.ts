import {
  detectTypesXmlValueViolations,
  getDayZFileTruthBlock,
  isNitradoOrDayZHelpQuestion,
  looksLikeDayZFileQuestion,
  lookupNitradoHelp,
  sanitizeDayZLootValues,
} from '../../src/modules/ai/nitradoHelp';

describe('nitradoHelp — DayZ 1.29 grounded', () => {
  test.each([
    ['Wie stelle ich die Tag-Nacht-Zeit in DayZ ein?', true],
    ['Was ist types.xml?', true],
    ['Was macht db/economy.xml?', true],
    ['cfgGameplay.json erklären', true],
    ['Wo wird Loot in Häusern definiert?', true],
    ['Welcher Tag ist heute?', false],
    ['wer ist Bundeskanzler', false],
  ])('%s -> %s', (q, expected) => {
    expect(isNitradoOrDayZHelpQuestion(q)).toBe(expected);
  });

  it('erkennt keinen allgemeinen Tag als DayZ-Tag/Nacht-Trigger', () => {
    expect(lookupNitradoHelp('Welcher Tag ist heute?').found).toBe(false);
  });

  it('erklaert types.xml ohne erfundene 25er-Grenze', () => {
    const a = lookupNitradoHelp('Wie funktioniert types.xml in DayZ 1.29?');
    expect(a.found).toBe(true);
    expect(a.text).toMatch(/Obergrenze 25|pauschale Obergrenze 25/i);
    expect(a.text).toMatch(/Chernarus.*120/i);
    expect(a.text).toMatch(/Livonia.*110/i);
    expect(a.text).toMatch(/Sakhal.*150/i);
    expect(a.text).not.toMatch(/einzig erlaubte Werte-Referenz/i);
  });

  it('behandelt economy.xml als regulaere CE-Missionsdatei', () => {
    const a = lookupNitradoHelp('Was ist db/economy.xml?');
    expect(a.found).toBe(true);
    expect(a.text).toMatch(/regulaere Mission-Datei/i);
    expect(a.text).toMatch(/Initialisierung|Laden|Speichern|Respawn/i);
  });

  it('liefert kartenspezifische M4A1-Werte statt Universaldefault', () => {
    const a = lookupNitradoHelp('M4A1 nominal in Sakhal 1.29 types.xml?');
    expect(a.found).toBe(true);
    expect(a.text).toMatch(/Sakhal: nominal=2, min=1/i);
    expect(a.text).not.toMatch(/nominal=15.*min=8/i);
  });

  it('zeigt bei kartenloser M4A1-Frage alle Varianten', () => {
    const a = lookupNitradoHelp('Wie ist M4A1 in der types.xml?');
    expect(a.text).toMatch(/Chernarus: nominal=1, min=1/i);
    expect(a.text).toMatch(/Livonia: nominal=1, min=1/i);
    expect(a.text).toMatch(/Sakhal: nominal=2, min=1/i);
  });

  it('Truth-Block korrigiert die alten falschen Universalregeln', () => {
    const t = getDayZFileTruthBlock();
    expect(t).toMatch(/db\/economy\.xml/);
    expect(t).toMatch(/Werte >25.*vorhanden/i);
    expect(t).toMatch(/min == nominal/i);
    expect(t).not.toMatch(/max\. 25|MUSS zwischen 1 und 25/i);
  });

  test.each([
    ['Wo wird Loot in Häusern definiert?', true],
    ['Was steckt in cfgspawnabletypes.xml?', true],
    ['Wo finde ich die types.xml?', true],
    ['Wie spät ist es?', false],
  ])('looksLikeDayZFileQuestion: %s -> %s', (q, expected) => {
    expect(looksLikeDayZFileQuestion(q)).toBe(expected);
  });

  it('schreibt reale hohe DayZ-Werte niemals still um', () => {
    const input = '<type name="WaterBottle"><nominal>100</nominal><min>85</min></type>';
    expect(sanitizeDayZLootValues(input)).toEqual({ text: input, changes: [] });
    expect(detectTypesXmlValueViolations(input)).toEqual([]);
  });
});
