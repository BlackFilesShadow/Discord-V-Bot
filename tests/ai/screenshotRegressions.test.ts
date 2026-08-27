import {
  answerDayz129CatalogQuestion,
  searchDayz129Types,
} from '../../src/modules/ai/dayz129Catalog';
import {
  DEVELOPER_IDENTITY_TRIGGER_PATTERN,
  isDeveloperIdentityQuestion,
} from '../../src/modules/ai/botIdentity';
import { GLOBAL_AI_TRIGGERS, findMatchingTrigger } from '../../src/modules/ai/triggers';

describe('Screenshot regressions', () => {
  test('grüner Feldrucksack löst exakt auf AliceBag_Green auf', () => {
    const answer = answerDayz129CatalogQuestion('hast du den Classname vom Feldrucksack Grün');
    expect(answer?.topic).toBe('type');
    expect(answer?.answer).toBe('Der Classname ist **`AliceBag_Green`**.');
    expect(answer?.answer).not.toContain('Animal_');
  });

  test('kurzes Feldrucksack-Follow-up funktioniert ebenfalls deterministisch', () => {
    const answer = answerDayz129CatalogQuestion('Feldrucksack Grün');
    expect(answer?.answer).toContain('AliceBag_Green');
  });

  test('Alicebag ohne Farbe zeigt nur die realen AliceBag-Varianten', () => {
    const names = searchDayz129Types('Alicebag', 10);
    expect(names).toEqual(['AliceBag_Black', 'AliceBag_Camo', 'AliceBag_Green']);

    const answer = answerDayz129CatalogQuestion('Alicebag');
    expect(answer?.answer).toContain('AliceBag_Black');
    expect(answer?.answer).toContain('AliceBag_Camo');
    expect(answer?.answer).toContain('AliceBag_Green');
    expect(answer?.answer).not.toContain('Animal_');
  });

  test('Kampfstiefel liefern die reale CombatBoots-Familie statt Fremdtreffern', () => {
    const names = searchDayz129Types('Kampfstiefel', 10);
    expect(names).toEqual([
      'CombatBoots_Beige',
      'CombatBoots_Black',
      'CombatBoots_Brown',
      'CombatBoots_Green',
      'CombatBoots_Grey',
    ]);

    const answer = answerDayz129CatalogQuestion('hast du von den Kampfstiefel den Classname?');
    expect(answer?.answer).toContain('CombatBoots_Green');
    expect(answer?.answer).not.toContain('HeadlightH7');
    expect(answer?.answer).not.toContain('MP5K');
  });

  test('Kampfstiefel mit Farbe löst auf genau eine Variante auf', () => {
    const answer = answerDayz129CatalogQuestion('Classname Kampfstiefel Grün');
    expect(answer?.answer).toBe('Der Classname ist **`CombatBoots_Green`**.');
  });

  test('Kampfanzugshose aus dem Produktions-Screenshot löst auf TTSKOPants statt MP5K auf', () => {
    const answer = answerDayz129CatalogQuestion('weißt du die Classname von Der Kampfanzugshose');
    expect(answer?.answer).toBe('Der Classname ist **`TTSKOPants`**.');
    expect(searchDayz129Types('Kampfanzugshose', 5)).toEqual(['TTSKOPants']);
    expect(answer?.answer).not.toContain('MP5K');
  });

  test('unbekannte Classname-Suchen raten weder MP5K noch einen anderen Einbuchstaben-Treffer', () => {
    expect(searchDayz129Types('xyzunbekannt', 5)).toEqual([]);
    const answer = answerDayz129CatalogQuestion('Wie lautet der Classname von xyzunbekannt?');
    expect(answer?.answer).toMatch(/keinen eindeutig passenden Classname/i);
    expect(answer?.answer).not.toContain('MP5K');
  });

  test('KI-System hinter V-Bot ist weder direkt noch global eine Entwicklerfrage', () => {
    const text = 'Die V AI Cloud ist das zentrale KI-System hinter dem V-Bot, welcher KI Anbieter aktuell verfügbar ist.';
    const re = new RegExp(DEVELOPER_IDENTITY_TRIGGER_PATTERN, 'i');
    expect(isDeveloperIdentityQuestion(text)).toBe(false);
    expect(re.test(text)).toBe(false);
    expect(findMatchingTrigger(GLOBAL_AI_TRIGGERS, text, true)).toBeNull();
  });

  test('echte Entwicklerfragen respektieren die Mention-only-Aktivierung', () => {
    expect(isDeveloperIdentityQuestion('Wer steckt hinter V-Bot?')).toBe(true);
    expect(findMatchingTrigger(GLOBAL_AI_TRIGGERS, 'Wer steckt hinter V-Bot?', false)).toBeNull();
    expect(findMatchingTrigger(GLOBAL_AI_TRIGGERS, 'Wer ist dein Entwickler?', true)?.id).toBe('system-developer-identity');
  });
});
