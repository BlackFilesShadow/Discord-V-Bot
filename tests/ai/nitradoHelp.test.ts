import {
  buildDayzTechnicalFallback,
  detectKnownDayzHallucinatedIdentifiers,
  detectTypesXmlValueViolations,
  extractDayzTechnicalIdentifiers,
  getDayZFileTruthBlock,
  isDayzTechnicalAdminQuestion,
  isNitradoOrDayZHelpQuestion,
  looksLikeDayZFileQuestion,
  lookupNitradoHelp,
  sanitizeDayZLootValues,
  validateDayzTechnicalAnswer,
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

  it('Truth-Block korrigiert alte Universalregeln und erzwingt Closed World', () => {
    const t = getDayZFileTruthBlock();
    expect(t).toMatch(/db\/economy\.xml/);
    expect(t).toMatch(/Werte >25.*vorhanden/i);
    expect(t).toMatch(/min == nominal/i);
    expect(t).toMatch(/CLOSED-WORLD-REGEL/);
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

  it('beantwortet Bauen+ mit belegter 1.29-cfggameplay-Struktur deterministisch', () => {
    const q = 'ich möchte auf meinen Dayz Server Bauen + Aktivieren';
    const a = lookupNitradoHelp(q);
    expect(a.found).toBe(true);
    expect(a.topicIds).toContain('dayz-help:basebuilding-build-anywhere');
    expect(a.directAnswer).toMatch(/cfggameplay\.json/i);
    expect(a.directAnswer).toMatch(/BaseBuildingData/);
    expect(a.directAnswer).toMatch(/enableCfgGameplayFile\s*=\s*1/);
    expect(a.directAnswer).toMatch(/disableIsCollidingBBoxCheck/);
    expect(a.directAnswer).toMatch(/disablePerformRoofCheck/);
    expect(a.directAnswer).toMatch(/disableDistanceCheck/);
  });

  it('trennt DayZ-Engine-Semantik von Nitrado-Bedienwegen', () => {
    const a = lookupNitradoHelp('DayZ Bauen + auf Nitrado aktivieren');
    expect(a.text).toMatch(/GEPRUEFTE DAYZ-ENGINE-\/SERVER-KONFIGURATION/);
    expect(a.text).toMatch(/NITRADO-BEDIENWEG/);
  });

  it('setzt unbekannte technische DayZ-Fragen auf fail-closed', () => {
    const a = lookupNitradoHelp('DayZ Server SuperLootTurbo aktivieren');
    expect(a.found).toBe(true);
    expect(a.text).toMatch(/GROUNDING-STATUS: NICHT AUSREICHEND BELEGT/);
    expect(a.text).toMatch(/keinen Parameter erfinden/i);
    expect(a.directAnswer).toBeUndefined();
  });

  it('erkennt technische DayZ-Adminfragen ohne Allgemeinfragen zu verschlucken', () => {
    expect(isDayzTechnicalAdminQuestion('DayZ Bauen + aktivieren')).toBe(true);
    expect(isDayzTechnicalAdminQuestion('Was ist DayZ?')).toBe(false);
    expect(isDayzTechnicalAdminQuestion('Was macht cfgGameplay.json?')).toBe(true);
  });

  it('blockiert bekannte und neu erfundene DayZ-Identifier nach der Generation', () => {
    const q = 'DayZ Bauen + aktivieren';
    const ground = lookupNitradoHelp(q).text;
    const known = validateDayzTechnicalAnswer('Setze `enableBuilding = true` und `MaxConstructionObjects = 500` in `serverDZ.cfg`.', ground, q);
    expect(known.valid).toBe(false);
    expect(known.violations.join(' ')).toMatch(/enableBuilding/);
    expect(known.violations.join(' ')).toMatch(/MaxConstructionObjects/);
    const invented = validateDayzTechnicalAnswer('Nutze `superMagicBuildSwitch = true` in `cfggameplay.json`.', ground, q);
    expect(invented.valid).toBe(false);
    expect(invented.violations.join(' ')).toMatch(/superMagicBuildSwitch/);
  });

  it('akzeptiert belegte Bauen+-Parameter und blockiert falsche Aktivierungswerte', () => {
    const q = 'DayZ Bauen + aktivieren';
    const ground = lookupNitradoHelp(q).text;
    expect(validateDayzTechnicalAnswer('Setze `enableCfgGameplayFile = 1;` und `disableDistanceCheck = true` in `cfggameplay.json`.', ground, q).valid).toBe(true);
    const wrong = validateDayzTechnicalAnswer('Setze `enableCfgGameplayFile = 2;` und `disableDistanceCheck = false`.', ground, q);
    expect(wrong.valid).toBe(false);
  });

  it('extrahiert technische Identifier konservativ', () => {
    expect(detectKnownDayzHallucinatedIdentifiers('enableBuilding MaxConstructionObjects')).toEqual(expect.arrayContaining(['enableBuilding', 'MaxConstructionObjects']));
    expect(extractDayzTechnicalIdentifiers('`cfggameplay.json` -> `BaseBuildingData`, superMagicBuildSwitch = true')).toEqual(expect.arrayContaining(['cfggameplay.json', 'BaseBuildingData', 'superMagicBuildSwitch']));
  });

  it('liefert nach blockierter Bauen+-Generation einen deterministischen Fallback', () => {
    const fallback = buildDayzTechnicalFallback('DayZ Bauen + aktivieren', ['superMagicBuildSwitch']);
    expect(fallback).toMatch(/cfggameplay\.json/i);
    expect(fallback).toMatch(/enableCfgGameplayFile\s*=\s*1/);
    expect(fallback).not.toMatch(/superMagicBuildSwitch/);
  });
});