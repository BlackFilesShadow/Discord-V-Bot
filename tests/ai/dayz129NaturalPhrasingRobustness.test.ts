import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';

/**
 * Regressionsschutz fuer eine Bug-Klasse, die real gemeldet wurde: natuerliche
 * volle Saetze mit deutschen Fuellwoertern ("fuer", "ist", "mich", "was", ...)
 * liessen die Classname-Aufloesung scheitern, obwohl "Classname X" (ohne
 * Fuellwoerter) fuer dasselbe Wort korrekt funktionierte. Ursache: die
 * bereinigte Frage wird von mehreren Matchern als EIN zusammenhaengender
 * Suchbegriff behandelt bzw. verlangt, dass jedes verbleibende Wort passt -
 * ein liegen gebliebenes Fuellwort wie "fuer" oder "mich" reichte deshalb aus,
 * um jeden echten Treffer zu verhindern. Diese Tests pinnen mehrere reale
 * Satzformulierungen (inklusive der beiden konkret gemeldeten Faelle) fest,
 * damit ein kuenftig wieder unvollstaendiges Fuellwort-Set sofort auffaellt,
 * statt erst durch einen Nutzer-Report entdeckt zu werden.
 */
describe('DayZ 1.29 Classname-Aufloesung ist robust gegen natuerliche Satzfuellwoerter', () => {
  test('meldeter Fall: "weißt du wie die Classname für AK ist?" bleibt korrekt fail-closed', () => {
    // "AK" ist ein echtes, aber absichtlich zu kurzes/mehrdeutiges Fragment
    // (73 Classnames enthalten "ak", darunter vier eigenstaendige Gewehre:
    // AK101/AK74/AKM/AKS74U). Das darf weiterhin NICHT geraten werden - dieser
    // Test stellt sicher, dass der Fuellwort-Fix diese bewusste Fail-Closed-
    // Grenze nicht versehentlich aufweicht.
    const answer = answerDayz129CatalogQuestion('weißt du wie die Classname für AK ist?');
    expect(answer?.answer).toContain('keinen eindeutig passenden Classname');
  });

  test('gemeldeter Fall: "hast du für mich den Classname von den Kampfstiefeln?" loest jetzt auf', () => {
    const answer = answerDayz129CatalogQuestion('hast du für mich den Classname von den Kampfstiefeln?');
    expect(answer?.answer).toContain('CombatBoots_Black');
  });

  test('weitere natuerliche Formulierungen mit denselben Fuellwoertern loesen ebenfalls auf', () => {
    expect(answerDayz129CatalogQuestion('weißt du wie die Classname für die Tundra ist?')?.answer)
      .toBe('Der Classname ist **`Winchester70`**.');
    expect(answerDayz129CatalogQuestion('was ist die Classname für den Feldrucksack?')?.answer)
      .toContain('AliceBag_Black');
    expect(answerDayz129CatalogQuestion('kannst du mir sagen was die Classname für Apfel ist?')?.answer)
      .toBe('Der Classname ist **`Apple`**.');
  });

  test('das erweiterte Fuellwort-Set macht keine Wortfragmente unsichtbar, die tatsaechlich Teil eines Alias sind', () => {
    // Sicherheitsnetz gegen eine zu aggressive Fuellwort-Liste: "ein" ist jetzt
    // ein Stoppwort, darf aber keinen Alias zerstoeren, dessen deutsches Wort
    // "ein" als Substring enthaelt (hier keiner - regressionsschuetzt trotzdem
    // die generelle Watsche gegen zu breite Wortgrenzen-Treffer).
    expect(answerDayz129CatalogQuestion('Classname Feldrucksack')?.answer).toContain('AliceBag_Black');
  });
});
