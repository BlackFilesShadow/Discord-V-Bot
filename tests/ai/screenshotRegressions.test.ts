import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';
import { DEVELOPER_IDENTITY_TRIGGER_PATTERN } from '../../src/modules/ai/botIdentity';

describe('Screenshot regressions', () => {
  test('grüner Feldrucksack löst nicht auf Tier-Classnames auf', () => {
    const answer = answerDayz129CatalogQuestion('hast du den Classname vom Feldrucksack Grün');
    expect(answer?.answer).toContain('AliceBag_Green');
    expect(answer?.answer).not.toContain('Animal_');
  });

  test('Kampfstiefel liefern nur echte CombatBoots-Varianten', () => {
    const answer = answerDayz129CatalogQuestion('hast du von den Kampfstiefel den Classname?');
    expect(answer?.answer).toContain('CombatBoots_');
    expect(answer?.answer).not.toContain('HeadlightH7');
    expect(answer?.answer).not.toContain('MP5K');
  });

  test('KI-System hinter V-Bot ist keine Entwicklerfrage', () => {
    const re = new RegExp(DEVELOPER_IDENTITY_TRIGGER_PATTERN, 'i');
    expect(re.test('Die V AI Cloud ist das zentrale KI-System hinter dem V-Bot.')).toBe(false);
  });
});
