/**
 * Regressionsschutz fuer die aus Bohemias eigener stringtable.csv generierte
 * deutsche Namenstabelle (scripts/generate_dayz129_stringtable.py). Nichts
 * hier ist geraten: jeder Classname->Name-Eintrag stammt direkt aus einer
 * echten Zeile dieser offiziellen Lokalisierungsdatei fuer einen bereits im
 * 1.29-Index verifizierten Classname. Diese Tests pinnen die grundlegenden
 * Eigenschaften des generierten Datensatzes fest, damit eine kuenftige
 * Neu-Generierung (anderes Quell-stringtable.csv) nicht unbemerkt eine
 * kaputte oder leere Tabelle einschleust.
 */
import {
  getDayz129GermanNames,
  getDayz129GermanAliases,
  isKnownDayz129Identifier,
} from '../../src/modules/ai/dayz129CatalogBase';
import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';

describe('DayZ 1.29 official German classname names (stringtable.csv)', () => {
  test('every generated entry maps to a real, verified classname with a non-empty, non-placeholder German name', () => {
    const names = getDayz129GermanNames();
    const entries = Object.entries(names);
    expect(entries.length).toBeGreaterThan(700);
    for (const [classname, german] of entries) {
      expect(isKnownDayz129Identifier(classname)).toBe(true);
      expect(german.length).toBeGreaterThan(0);
      expect(german.startsWith('$UNT$')).toBe(false);
    }
  });

  test('every generated alias key resolves through the explicit Classname-path to a real classname', () => {
    const aliases = getDayz129GermanAliases();
    const keys = Object.keys(aliases);
    expect(keys.length).toBeGreaterThan(400);
    for (const key of keys) {
      const answer = answerDayz129CatalogQuestion(`Classname ${key}`);
      expect(answer).not.toBeNull();
      for (const id of answer!.ids) {
        expect(id.startsWith('dayz129:type:')).toBe(true);
        expect(isKnownDayz129Identifier(id.slice('dayz129:type:'.length))).toBe(true);
      }
    }
  });

  // Konkrete, gegen die reale stringtable.csv verifizierte Stichproben -
  // inklusive des urspruenglich gemeldeten "Feuerzeug"-Falls und zweier
  // vorher falscher Handeintraege, die dieser Abgleich selbst aufgedeckt hat.
  it.each([
    ['Feuerzeug', 'PetrolLighter'],
    ['Taschenlampe', 'Flashlight'],
    ['Zündkerze', 'SparkPlug'],
    ['Kampfstiefel', 'TTSKOBoots'],
    ['Kampfanzugshose', 'BDUPants'],
    ['Lagerfeuer', 'Fireplace'],
  ])('resolves the official German name "%s" to %s', (word, expected) => {
    expect(answerDayz129CatalogQuestion(`Classname ${word}`)?.answer)
      .toBe(`Der Classname ist **\`${expected}\`**.`);
  });

  test('a color family shared under one official name lists all real variants and narrows on request', () => {
    const answer = answerDayz129CatalogQuestion('Classname Feldrucksack');
    expect(answer?.answer).toContain('AliceBag_Black');
    expect(answer?.answer).toContain('AliceBag_Camo');
    expect(answer?.answer).toContain('AliceBag_Green');
    expect(answerDayz129CatalogQuestion('Classname Feldrucksack Grün')?.answer)
      .toBe('Der Classname ist **`AliceBag_Green`**.');
  });
});
