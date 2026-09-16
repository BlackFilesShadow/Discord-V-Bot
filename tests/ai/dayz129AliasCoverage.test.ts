import {
  EXACT_ALIASES,
  EVENT_SYNONYMS,
  TYPE_SYNONYMS,
  isKnownDayz129Identifier,
} from '../../src/modules/ai/dayz129CatalogBase';
import {
  answerDayz129CatalogQuestion,
  searchDayz129Events,
  searchDayz129Types,
} from '../../src/modules/ai/dayz129Catalog';

/**
 * "Ausnahmslos verarbeitet" als CI-erzwungene Eigenschaft statt einer
 * Behauptung: jedes Wort, das die Aufloesungs-Engine als bekannt fuehrt
 * (EXACT_ALIASES/TYPE_SYNONYMS/EVENT_SYNONYMS), MUSS auch tatsaechlich zu
 * mindestens einem realen, indexierten Classname/Eventnamen fuehren.
 *
 * Genau diese Klasse Bug hat "Apfel" (Wort in TYPE_SYNONYMS bekannt, aber der
 * strikte Lookup-Pfad kannte keine Uebersetzung) und "Gewehr" (Wort auf ein
 * Token uebersetzt, das in KEINEM realen Classname vorkommt - "rifle" taucht
 * in keinem der 1974 echten 1.29-Classnames auf, DayZ benennt Gewehre nach
 * Modell wie Mosin9130/SVD/M4A1) verursacht. Ein neuer Eintrag, der auf
 * nichts Reales zeigt, faellt ab sofort hier auf, statt erst durch einen
 * Nutzer-Report entdeckt zu werden.
 */
describe('DayZ 1.29 alias/synonym coverage (ausnahmslos)', () => {
  test.each(Object.entries(EXACT_ALIASES))(
    'EXACT_ALIASES "%s" -> %s resolves via the explicit Classname-path to real, known classname(s)',
    (word, target) => {
      const answer = answerDayz129CatalogQuestion(`Classname ${word}`);
      expect(answer).not.toBeNull();
      expect(answer!.ids.length).toBeGreaterThan(0);
      for (const id of answer!.ids) {
        expect(id.startsWith('dayz129:type:')).toBe(true);
        const name = id.slice('dayz129:type:'.length);
        expect(isKnownDayz129Identifier(name)).toBe(true);
      }
      // Jeder resolvierte Name muss tatsaechlich zum Alias-Ziel gehoeren
      // (exakter Treffer oder eine Farbvariante `${target}_<Farbe>`).
      for (const id of answer!.ids) {
        const name = id.slice('dayz129:type:'.length);
        expect(name === target || name.startsWith(`${target}_`)).toBe(true);
      }
    },
  );

  test.each(Object.entries(TYPE_SYNONYMS))(
    'TYPE_SYNONYMS "%s" -> %j is not a dead mapping (resolves to >=1 real classname)',
    (word) => {
      const results = searchDayz129Types(word, 10);
      expect(results.length).toBeGreaterThan(0);
      for (const name of results) expect(isKnownDayz129Identifier(name)).toBe(true);
    },
  );

  test.each(Object.entries(EVENT_SYNONYMS))(
    'EVENT_SYNONYMS "%s" -> %j is not a dead mapping (resolves to >=1 real event)',
    (word) => {
      const results = searchDayz129Events(word, 10);
      expect(results.length).toBeGreaterThan(0);
      for (const name of results) expect(isKnownDayz129Identifier(name)).toBe(true);
    },
  );

  // Naturliche "wie heisst X"-Fragen ohne jeden DayZ-Marker muessen fuer jeden
  // Alias, der auf GENAU einen Classname zeigt (keine Farbfamilie), ebenfalls
  // funktionieren - nicht nur der explizite "Classname X"-Pfad. Farbfamilien
  // (z.B. "Feldrucksack" -> mehrere AliceBag_*-Varianten) bleiben hier
  // erwartungsgemaess mehrdeutig/leer, weil ohne Farbangabe kein eindeutiger
  // Treffer existiert; das ist korrektes Fail-Closed-Verhalten, kein Bug.
  const singleTargetAliases = Object.entries(EXACT_ALIASES).filter(
    ([, target]) => isKnownDayz129Identifier(target),
  );
  test.each(singleTargetAliases)(
    'plain "wie heisst X" without any DayZ marker resolves "%s" -> %s',
    (word, target) => {
      const answer = answerDayz129CatalogQuestion(`Wie heißt ${word}?`);
      expect(answer?.answer).toBe(`Der Classname ist **\`${target}\`**.`);
    },
  );
});
