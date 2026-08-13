import {
  buildDayzTechnicalFallback,
  detectKnownDayzHallucinatedIdentifiers,
  extractDayzTechnicalIdentifiers,
  enrichDayzTechnicalFollowUp,
  getDayZFileTruthBlock,
  isDayzTechnicalAdminQuestion,
  isNitradoOrDayZHelpQuestion,
  looksLikeDayZFileQuestion,
  lookupNitradoHelp,
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
  ])('%s -> %s', (q, expected) => {
    expect(isNitradoOrDayZHelpQuestion(q)).toBe(expected);
  });

  it('behält die geprüfte types.xml-Wissensbasis bei', () => {
    const a = lookupNitradoHelp('Wie funktioniert types.xml in DayZ 1.29?');
    expect(a.found).toBe(true);
    expect(a.text).toMatch(/Chernarus.*120/i);
    expect(a.text).toMatch(/Livonia.*110/i);
    expect(a.text).toMatch(/Sakhal.*150/i);
  });

  it('behält Closed-World-Grounding intern verfügbar', () => {
    const t = getDayZFileTruthBlock();
    expect(t).toMatch(/CLOSED-WORLD-REGEL/);
    expect(t).toMatch(/db\/economy\.xml/);
  });

  it('erkennt technische DayZ-Fragen weiterhin korrekt', () => {
    expect(looksLikeDayZFileQuestion('Was steckt in cfgspawnabletypes.xml?')).toBe(true);
    expect(isDayzTechnicalAdminQuestion('DayZ Bauen + aktivieren')).toBe(true);
    expect(isDayzTechnicalAdminQuestion('Was ist DayZ?')).toBe(false);
  });

  it('beantwortet Bauen+ kompakt ohne ungefragte Mythos-Liste', () => {
    const a = lookupNitradoHelp('ich möchte auf meinen Dayz Server Bauen + Aktivieren');
    expect(a.found).toBe(true);
    expect(a.topicIds).toContain('dayz-help:basebuilding-build-anywhere');
    expect(a.directAnswer).toMatch(/cfggameplay\.json/i);
    expect(a.directAnswer).toMatch(/BaseBuildingData/);
    expect(a.directAnswer).toMatch(/enableCfgGameplayFile\s*=\s*1/);
    expect(a.directAnswer).toMatch(/disableIsCollidingBBoxCheck/);
    expect(a.directAnswer).toMatch(/disablePerformRoofCheck/);
    expect(a.directAnswer).toMatch(/disableDistanceCheck/);
    expect(a.directAnswer).not.toMatch(/enableBuilding|EnableConstruction|BuildDistance|MaxConstructionObjects/);
    expect(a.directAnswer).not.toMatch(/Alle drei gelieferten|disableBaseDamage|disableContainerDamage/i);
  });

  it('korrigiert einen falschen Bauen+-Begriff gezielt, wenn der Nutzer ihn nennt', () => {
    const a = lookupNitradoHelp('Muss ich fuer Bauen + enableBuilding auf true setzen?');
    expect(a.directAnswer).toMatch(/`enableBuilding`/);
    expect(a.directAnswer).toMatch(/kein belegter Vanilla-DayZ-1\.29-Parameter/i);
    expect(a.directAnswer).not.toMatch(/EnableConstruction|BuildDistance|MaxConstructionObjects/);
  });

  it('validiert technische Antworten weiterhin fail-closed', () => {
    const q = 'DayZ Bauen + aktivieren';
    const ground = lookupNitradoHelp(q).text;
    const bad = validateDayzTechnicalAnswer('Setze `enableBuilding = true`.', ground, q);
    expect(bad.valid).toBe(false);
    expect(bad.violations.join(' ')).toMatch(/enableBuilding/);
    const invented = validateDayzTechnicalAnswer('Nutze `superMagicBuildSwitch = true` in `cfggameplay.json`.', ground, q);
    expect(invented.valid).toBe(false);
    expect(invented.violations.join(' ')).toMatch(/superMagicBuildSwitch/);
    expect(validateDayzTechnicalAnswer('Setze `enableCfgGameplayFile = 1;` und `disableDistanceCheck = true` in `cfggameplay.json`.', ground, q).valid).toBe(true);
  });

  it('erklaert Event.xml kompakt ohne ungefragten Beispiel- oder Warnblock', () => {
    const a = lookupNitradoHelp('Was ist die Event.xml?');
    expect(a.found).toBe(true);
    expect(a.directAnswer).toMatch(/events\.xml/);
    expect(a.directAnswer).toMatch(/dynamische Events/i);
    expect(a.directAnswer).not.toMatch(/StaticHeliCrash|Wreck_UH1Y|Start-\/Endzeit|Regenphasen|Zombie-Wellen/i);
  });

  it('liefert events.xml-Beispielcode erst auf Nachfrage', () => {
    const a = lookupNitradoHelp('Kannst du mir fuer events.xml ein Beispiel zeigen?');
    expect(a.directAnswer).toMatch(/StaticHeliCrash/);
    expect(a.directAnswer).toMatch(/Wreck_UH1Y/);
    expect(a.directAnswer).toMatch(/<event name=\"StaticHeliCrash\">/);
  });

  it('korrigiert eine Zeitplan-Annahme nur wenn sie in der Frage vorkommt', () => {
    const a = lookupNitradoHelp('Kann ich in events.xml eine Startzeit und Endzeit fuer Zombie-Wellen setzen?');
    expect(a.directAnswer).toMatch(/Start-\/Endzeitplan|Zombie-Wellen/i);
  });

  it('versteckt interne Validierungsdetails im Fallback', () => {
    const fallback = buildDayzTechnicalFallback('DayZ Server SuperLootTurbo aktivieren', ['superMagicBuildSwitch']);
    expect(fallback).toMatch(/keinen ausreichend sicheren/i);
    expect(fallback).not.toMatch(/superMagicBuildSwitch|verworfen|Violation|Grounding/i);
  });

  it('kontextualisiert kurze Folgefragen weiter sauber', () => {
    expect(enrichDayzTechnicalFollowUp('hast du ein Beispiel?', 'Die events.xml definiert dynamische Events.')).toBe('events.xml: hast du ein Beispiel?');
    expect(enrichDayzTechnicalFollowUp('Wer ist Bundeskanzler?', 'Die events.xml definiert dynamische Events.')).toBe('Wer ist Bundeskanzler?');
  });

  it('behält Identifier-Erkennung für interne Validierung', () => {
    expect(detectKnownDayzHallucinatedIdentifiers('enableBuilding MaxConstructionObjects')).toEqual(expect.arrayContaining(['enableBuilding', 'MaxConstructionObjects']));
    expect(extractDayzTechnicalIdentifiers('`cfggameplay.json` -> `BaseBuildingData`, superMagicBuildSwitch = true')).toEqual(expect.arrayContaining(['cfggameplay.json', 'BaseBuildingData', 'superMagicBuildSwitch']));
  });
});