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
  test('loads the complete supplied corpus', () => {
    const index = getDayz129Index();
    expect(index.version).toBe('1.29.163451');
    expect(index.sourceTag).toBe('USER_ZIPS_1.29.163451');
    expect(getDayz129CatalogStats()).toEqual({ types: 1974, events: 72, paths: 47 });
    expect(Object.keys(index.maps.chernarus.types)).toHaveLength(1942);
    expect(Object.keys(index.maps.livonia.types)).toHaveLength(1939);
    expect(Object.keys(index.maps.sakhal.types)).toHaveLength(1955);
  });

  test('recognizes every indexed file and every identifier', () => {
    const index = getDayz129Index();
    for (const path of index.allRelativePaths) {
      const a = answerDayz129CatalogQuestion(`DayZ: was ist die Datei ${path}?`);
      expect(a?.topic).toBe('file');
      expect(a?.answer).toContain(path);
    }
    for (const name of index.allTypeNames) expect(isKnownDayz129Identifier(name)).toBe(true);
    for (const name of index.allEventNames) expect(isKnownDayz129Identifier(name)).toBe(true);
  });

  test('keeps file explanations grounded', () => {
    const messages = answerDayz129CatalogQuestion('Was ist die message.xml?')?.answer ?? '';
    expect(messages).toMatch(/delay|repeat|deadline/i);
    expect(messages).not.toMatch(/\$PLAYERS|\$TARGET|Kill-Feed/i);
    const types = answerDayz129CatalogQuestion('Was ist die Types.xml?')?.answer ?? '';
    expect(types).toMatch(/Central Economy/i);
    expect(types).toMatch(/nominal/i);
    expect(types).toMatch(/Typen|Classnames/i);
    expect(types).toMatch(/keine einfache Liste von festen Spawnpunkten/i);
  });

  test('natural German type and event search stays on real identifiers', () => {
    expect(searchDayz129Types('Holzbretter', 5)).toContain('WoodenPlank');
    expect(searchDayz129Types('Nagelbox', 5)[0]).toBe('NailBox');
    expect(searchDayz129Types('Wasserflasche', 5)[0]).toBe('WaterBottle');
    expect(searchDayz129Events('Helikopterabsturz Event', 5)).toContain('StaticHeliCrash');
  });

  test('pure classname requests are classname-only', () => {
    const a = answerDayz129CatalogQuestion('DayZ Classname WoodenPlank');
    expect(a?.topic).toBe('type');
    expect(a?.answer).toBe('Der Classname ist **`WoodenPlank`**.');
    expect(a?.answer).not.toMatch(/Chernarus|Livonia|Sakhal|crafted=/);
    expect(answerDayz129CatalogQuestion('Classname M4A1 auf Sakhal')?.answer)
      .toBe('Der Classname ist **`M4A1`**.');
  });

  test('explicit technical identifiers still work without spelling out DayZ', () => {
    const wooden = answerDayz129CatalogQuestion('Welche Werte hat WoodenPlank?')?.answer ?? '';
    expect(wooden).toMatch(/Chernarus/);
    expect(wooden).toMatch(/crafted=1/);

    const sakhal = answerDayz129CatalogQuestion('Welche Werte hat M4A1 auf Sakhal?')?.answer ?? '';
    expect(sakhal).toMatch(/Sakhal/);
    expect(sakhal).not.toMatch(/Chernarus|Livonia/);

    const event = answerDayz129CatalogQuestion('Event StaticHeliCrash auf Livonia')?.answer ?? '';
    expect(event).toMatch(/Livonia/);
  });

  test('plain "wie heisst X" naming questions resolve without any DayZ/classname marker', () => {
    // Regressionsschutz: der aeussere Scope-Gate (explicitCatalogIntent)
    // verlangte bisher ein explizites Marker-Wort ("classname", "types.xml",
    // einen kuratierten Alias oder einen technisch aussehenden Identifier).
    // Reine Umgangssprache wie "Wie heisst die Winchester?" erreichte die
    // eigentliche Such-Engine dadurch nie, obwohl V3 den Alias laengst kennt.
    expect(answerDayz129CatalogQuestion('Wie heißt die Winchester?')?.answer)
      .toBe('Der Classname ist **`Winchester70`**.');
    expect(answerDayz129CatalogQuestion('Wie heißt der Generator?')?.answer)
      .toBe('Der Classname ist **`PowerGenerator`**.');
    expect(answerDayz129CatalogQuestion('Wie heißt der Feldrucksack in Grün?')?.answer)
      .toBe('Der Classname ist **`AliceBag_Green`**.');
  });

  test('naming questions stay silent (null) instead of guessing on no or ambiguous matches', () => {
    // Ein Fehltreffer darf hier NIE eine DayZ-Fehlantwort erzwingen - sonst
    // wuerde eine echte Allgemeinfrage wie "Wie heisst der Bundeskanzler?"
    // faelschlich "kein Classname gefunden" statt der echten Antwort bekommen.
    expect(answerDayz129CatalogQuestion('Wie heißt der Bundeskanzler von Deutschland?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Wie heißt die Hauptstadt von Frankreich?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Wie heißt mein bester Freund?')).toBeNull();
    // "AK" matcht mehrere reale Classnames (AKM, AKS74U, ...) - mehrdeutig,
    // deshalb bewusst kein Treffer statt eines geratenen Namens.
    expect(answerDayz129CatalogQuestion('Wie heißt AK?')).toBeNull();
    // "Holzbrett" matcht mehrere reale wooden-*-Classnames - ebenfalls
    // mehrdeutig und deshalb kein Treffer ueber diesen schwachen Pfad.
    expect(answerDayz129CatalogQuestion('Wie heißt das Holzbrett?')).toBeNull();
  });

  test('"was heisst X" (Bedeutungsfrage) triggert den Naming-Pfad nicht', () => {
    // "was heisst X" ist im Deutschen ueblicherweise eine Bedeutungsfrage
    // ("was heisst 'nominal'?"), keine Namensfrage - bewusst nicht Teil des
    // schwachen Zusatzpfads, um keine Bedeutungsfragen falsch zu kapern.
    expect(answerDayz129CatalogQuestion('Was heißt eigentlich Servus auf Englisch?')).toBeNull();
  });

  test('ambiguous general words cannot accidentally trigger the DayZ catalog', () => {
    expect(answerDayz129CatalogQuestion('Apple')).toBeNull();
    expect(answerDayz129CatalogQuestion('Welche Vitamine hat Apple?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Erzähl mir etwas über eine Jacke.')).toBeNull();
    expect(answerDayz129CatalogQuestion('Wie funktioniert ein Zelt beim Camping?')).toBeNull();
  });

  test('never presents vanilla catalog values as current live-server values', () => {
    expect(answerDayz129CatalogQuestion('Welche Werte hat WoodenPlank auf unserem Server?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Welchen nominal Wert haben wir bei uns fuer M4A1?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Welche Werte hat M4A1 auf Slot 2?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Was bedeutet nominal in types.xml?')).not.toBeNull();
  });

  test('events keep their map-specific detail behavior', () => {
    const e = answerDayz129CatalogQuestion('Event StaticHeliCrash auf Livonia')?.answer ?? '';
    expect(e).toMatch(/Livonia/);
    expect(e).not.toMatch(/Chernarus|Sakhal/);
  });

  test('unknown DayZ-looking files fail closed', () => {
    const a = answerDayz129CatalogQuestion('DayZ: was ist die SuperLootTurbo.xml?');
    expect(a?.topic).toBe('unknown-file');
    expect(a?.answer).toMatch(/erfinde/i);
  });

  test('generic referential follow-up keeps the resolved DayZ subject', () => {
    expect(enrichDayz129FollowUp('welche Werte?', '**DayZ-Classname: `WoodenPlank`**'))
      .toBe('Classname WoodenPlank: welche Werte?');
    expect(enrichDayz129FollowUp('und auf Livonia?', '**DayZ-Event: `StaticHeliCrash`**'))
      .toBe('Event StaticHeliCrash: und auf Livonia?');
  });

  test('a new general question is never converted into a DayZ follow-up just because the previous answer was DayZ', () => {
    const question = 'kannst du mir Photosynthese erklären?';
    expect(enrichDayz129FollowUp(question, '**DayZ-Classname: `WoodenPlank`**')).toBe(question);
    expect(enrichDayz129FollowUp('Erzähl mir einen Witz.', '**DayZ-Event: `StaticHeliCrash`**')).toBe('Erzähl mir einen Witz.');
  });
});
