import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';

/**
 * Regressionsschutz fuer answerStructuralCountQuestion: der generierte Index
 * speichert fuer alle 42 Dateien pro Karte eine Elementstruktur (nicht nur
 * types.xml/events.xml), aber die Werte lagen bisher ungenutzt. Diese Tests
 * pinnen die konkreten, im Referenzdokument (docs/dayz-1.29-grounding.md)
 * belegten Zahlen, damit ein kuenftiger Index-Regenerierungslauf abweichende
 * Werte sofort auffallen laesst statt still falsch zu werden.
 */
describe('DayZ 1.29 structural count answers (bereits indexierte, bisher ungenutzte Daten)', () => {
  test('zombie territory zone counts match the documented per-map values', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Zombie-Zonen gibt es?');
    expect(answer?.answer).toContain('- Chernarus: 768');
    expect(answer?.answer).toContain('- Livonia: 328');
    expect(answer?.answer).toContain('- Sakhal: 417');
  });

  test('a named map narrows the answer to just that map', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Zombie-Zonen hat Sakhal?');
    expect(answer?.answer).toContain('- Sakhal: 417');
    expect(answer?.answer).not.toContain('Chernarus');
    expect(answer?.answer).not.toContain('Livonia');
  });

  test('a different territory animal resolves to its own file and count', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Wildschwein-Territorien hat Chernarus?');
    expect(answer?.answer).toContain('env/wild_boar_territories.xml');
    expect(answer?.answer).toContain('- Chernarus: 207');
  });

  test('cfgeventspawns.xml categories (definitions/positions/zones) resolve independently and match the documented counts', () => {
    const definitions = answerDayz129CatalogQuestion('wie viele Event-Definitionen hat Chernarus?');
    expect(definitions?.answer).toContain('- Chernarus: 33');

    const positions = answerDayz129CatalogQuestion('wie viele Event-Positionen hat Chernarus?');
    expect(positions?.answer).toContain('- Chernarus: 1435');

    const zones = answerDayz129CatalogQuestion('wie viele Event-Zonen hat Chernarus?');
    expect(zones?.answer).toContain('- Chernarus: 9');
  });

  test('mapgroup counts match the documented per-map values', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Mapgroups hat Livonia?');
    expect(answer?.answer).toContain('- Livonia: 5723');
  });

  test('answer carries a structural source citation, not a guessed value', () => {
    const answer = answerDayz129CatalogQuestion('wie viele Zombie-Zonen hat Sakhal?');
    expect(answer?.answer).toMatch(/Quelle:.*elementCounts|Quelle:.*zone.*env\/zombie_territories\.xml/i);
    expect(answer?.ids.every((id) => id.startsWith('dayz129:structure:'))).toBe(true);
  });

  test('unrelated count questions stay null instead of guessing a category', () => {
    expect(answerDayz129CatalogQuestion('wie viele Äpfel gibt es?')).toBeNull();
    expect(answerDayz129CatalogQuestion('wie viele Mitglieder hat der Discord-Server?')).toBeNull();
    expect(answerDayz129CatalogQuestion('wie viele Bananen gibt es auf dem Server?')).toBeNull();
  });

  test('a plain question without "wie viele"/"Anzahl" never triggers a structural count answer', () => {
    expect(answerDayz129CatalogQuestion('Zombie-Zonen sind gruselig')).toBeNull();
  });
});
