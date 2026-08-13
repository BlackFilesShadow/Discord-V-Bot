import { answerDayz129CatalogQuestion, getDayz129Index } from '../../src/modules/ai/dayz129Catalog';

describe('full types classname coverage', () => {
  it('resolves every indexed classname exactly', () => {
    const names = getDayz129Index().allTypeNames;
    expect(names.length).toBeGreaterThanOrEqual(1974);
    for (const name of names) {
      const r = answerDayz129CatalogQuestion(`Classname ${name}`);
      expect(r?.topic).toBe('type');
      expect(r?.answer).toBe(`Der Classname ist **\`${name}\`**.`);
    }
  });
});
