import { answerDayz129CatalogQuestion, getDayz129Index } from '../../src/modules/ai/dayz129Catalog';

describe('DayZ classname intent', () => {
  test('Tundra lookup wins over types.xml file mention', () => {
    const a = answerDayz129CatalogQuestion('wie heißt die Tundra in der Types.xml?');
    expect(getDayz129Index().allTypeNames).toContain('Winchester70');
    expect(a?.topic).toBe('type');
    expect(a?.answer).toContain('Winchester70');
    expect(a?.answer).not.toContain('WoodenPlank');
  });

  test('restock meaning is not described as one spawn point timer', () => {
    const a = answerDayz129CatalogQuestion('was ist der Restock?');
    expect(a?.answer).toMatch(/CE-Zeitparameter/i);
    expect(a?.answer).toMatch(/kein Timer eines einzelnen Loot-\/Spawnpunkts/i);
  });
});
