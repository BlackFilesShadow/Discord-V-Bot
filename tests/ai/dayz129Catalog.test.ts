import {
  answerDayz129CatalogQuestion,
  enrichDayz129FollowUp,
  getDayz129CatalogStats,
  getDayz129Index,
  isKnownDayz129Identifier,
  searchDayz129Events,
  searchDayz129Types,
} from '../../src/modules/ai/dayz129Catalog';

describe('DayZ 1.29 complete grounded catalog', () => {
  test('loads the exact complete corpus from the three supplied datasets', () => {
    const index = getDayz129Index();
    expect(index.version).toBe('1.29.163451');
    expect(index.sourceTag).toBe('USER_ZIPS_1.29.163451');
    expect(getDayz129CatalogStats()).toEqual({ types: 1974, events: 72, paths: 47 });
    expect(Object.keys(index.maps.chernarus.types)).toHaveLength(1942);
    expect(Object.keys(index.maps.livonia.types)).toHaveLength(1939);
    expect(Object.keys(index.maps.sakhal.types)).toHaveLength(1955);
    expect(Object.keys(index.maps.chernarus.events)).toHaveLength(59);
    expect(Object.keys(index.maps.livonia.events)).toHaveLength(53);
    expect(Object.keys(index.maps.sakhal.events)).toHaveLength(62);
  });

  test('recognizes every indexed file path and basename without LLM guessing', () => {
    const index = getDayz129Index();
    for (const path of index.allRelativePaths) {
      const a = answerDayz129CatalogQuestion(`DayZ: was ist die Datei ${path}?`);
      expect(a?.topic).toBe('file');
      expect(a?.answer).toContain(path);
    }
  });

  test('normalizes common singular filename mistakes', () => {
    expect(answerDayz129CatalogQuestion('Was ist die Event.xml?')?.answer).toMatch(/db\/events\.xml/);
    expect(answerDayz129CatalogQuestion('Was ist die Type.xml?')?.answer).toMatch(/db\/types\.xml/);
    expect(answerDayz129CatalogQuestion('Was ist die Message.xml?')?.answer).toMatch(/db\/messages\.xml/);
    expect(answerDayz129CatalogQuestion('Was ist die Global.xml?')?.answer).toMatch(/db\/globals\.xml/);
  });

  test('messages.xml explanation is grounded and excludes the previous hallucinations', () => {
    const a = answerDayz129CatalogQuestion('Was ist die message.xml?');
    expect(a?.topic).toBe('file');
    expect(a?.answer).toMatch(/delay/);
    expect(a?.answer).toMatch(/repeat/);
    expect(a?.answer).toMatch(/deadline/);
    expect(a?.answer).toMatch(/onconnect/i);
    expect(a?.answer).toMatch(/shutdown/);
    expect(a?.answer).toMatch(/#name/);
    expect(a?.answer).toMatch(/#tmin/);
    expect(a?.answer).toMatch(/Sakhal.*nicht vorhanden/i);
    expect(a?.answer).not.toMatch(/\$PLAYERS|\$TARGET|Kill-Feed|UI-Hinweis|<message name=/i);
  });

  test('types.xml explanation keeps CE meaning conservative and uses a real example', () => {
    const a = answerDayz129CatalogQuestion('Was ist die Types.xml?');
    expect(a?.topic).toBe('file');
    expect(a?.answer).toMatch(/Central Economy/i);
    expect(a?.answer).toMatch(/nominal/);
    expect(a?.answer).toMatch(/WoodenPlank/);
    expect(a?.answer).not.toMatch(
      /nominal\s+(?:ist|bedeutet|entspricht)\s+(?:die\s+)?maximale Menge/i,
    );
    expect(a?.answer).toMatch(/nominal.*nicht pauschal.*maximale Menge/i);
  });

  test('knows every real classname and never needs to invent one', () => {
    const index = getDayz129Index();
    for (const name of index.allTypeNames) expect(isKnownDayz129Identifier(name)).toBe(true);
    expect(isKnownDayz129Identifier('WoodenPlank')).toBe(true);
    expect(isKnownDayz129Identifier('SuperMagicBuildSwitch')).toBe(false);
  });

  test('resolves natural German item descriptions only to real indexed classnames', () => {
    expect(searchDayz129Types('Holzbretter', 5)).toContain('WoodenPlank');
    expect(searchDayz129Types('Holzbretter', 20)).not.toContain('PileOfWoodenPlanks');
    expect(searchDayz129Types('Nagelbox', 5)[0]).toBe('NailBox');
    expect(searchDayz129Types('Wasserflasche', 5)[0]).toBe('WaterBottle');
    expect(searchDayz129Types('Metallplatte', 5)[0]).toBe('MetalPlate');
    expect(searchDayz129Types('Kabeltrommel', 5)[0]).toBe('CableReel');
    expect(searchDayz129Types('Seekiste', 5)[0]).toBe('SeaChest');
    for (const candidate of searchDayz129Types('Holzbretter', 20)) expect(isKnownDayz129Identifier(candidate)).toBe(true);
  });

  test('answers an exact real classname with map-specific values', () => {
    const a = answerDayz129CatalogQuestion('DayZ Classname WoodenPlank');
    expect(a?.topic).toBe('type');
    expect(a?.answer).toMatch(/WoodenPlank/);
    expect(a?.answer).toMatch(/Chernarus/);
    expect(a?.answer).toMatch(/Livonia/);
    expect(a?.answer).toMatch(/Sakhal/);
    expect(a?.answer).toMatch(/crafted=1/);
  });

  test('knows all 72 real event names and supports natural event lookup', () => {
    const index = getDayz129Index();
    expect(index.allEventNames).toHaveLength(72);
    for (const name of index.allEventNames) expect(isKnownDayz129Identifier(name)).toBe(true);
    expect(searchDayz129Events('Helikopterabsturz Event', 5)).toContain('StaticHeliCrash');
    expect(searchDayz129Events('Militär Konvoi Event', 5)).toContain('StaticMilitaryConvoy');
    expect(searchDayz129Events('Wolf Event', 5)).toContain('AnimalWolf');
  });

  test('answers exact events with map-specific fields and children', () => {
    const a = answerDayz129CatalogQuestion('Event StaticHeliCrash');
    expect(a?.topic).toBe('event');
    expect(a?.answer).toMatch(/StaticHeliCrash/);
    expect(a?.answer).toMatch(/Wreck_UH1Y/);
    expect(a?.answer).toMatch(/Chernarus/);
    expect(a?.answer).toMatch(/Livonia/);
    expect(a?.answer).toMatch(/Sakhal/);
  });

  test('unknown DayZ-looking files fail closed', () => {
    const a = answerDayz129CatalogQuestion('DayZ: was ist die SuperLootTurbo.xml?');
    expect(a?.topic).toBe('unknown-file');
    expect(a?.answer).toMatch(/keinem.*Datensaetze/i);
    expect(a?.answer).toMatch(/erfinde/i);
  });

  test('map-specific type and event questions only report the requested map', () => {
    const t = answerDayz129CatalogQuestion('Classname M4A1 auf Sakhal');
    expect(t?.answer).toMatch(/Sakhal/);
    expect(t?.answer).not.toMatch(/Chernarus/);
    expect(t?.answer).not.toMatch(/Livonia/);

    const e = answerDayz129CatalogQuestion('Event StaticHeliCrash auf Livonia');
    expect(e?.answer).toMatch(/Livonia/);
    expect(e?.answer).not.toMatch(/Chernarus/);
    expect(e?.answer).not.toMatch(/Sakhal/);
  });

  test('generic follow-up works for any indexed file, type and event', () => {
    expect(enrichDayz129FollowUp('hast du ein Beispiel?', 'Die Datei `db/types.xml` definiert die Central Economy.')).toBe('db/types.xml: hast du ein Beispiel?');
    expect(enrichDayz129FollowUp('hast du ein Beispiel?', 'Die Datei `db/messages.xml` definiert Server-Messages.')).toBe('db/messages.xml: hast du ein Beispiel?');
    expect(enrichDayz129FollowUp('welche Werte?', '**DayZ-Classname: `WoodenPlank`**')).toBe('Classname WoodenPlank: welche Werte?');
    expect(enrichDayz129FollowUp('und auf Livonia?', '**DayZ-Event: `StaticHeliCrash`**')).toBe('Event StaticHeliCrash: und auf Livonia?');
    expect(enrichDayz129FollowUp('Wer ist Bundeskanzler?', 'Die Datei `db/types.xml` definiert die Central Economy.')).toBe('Wer ist Bundeskanzler?');
  });
});
