import { answerDayz129CatalogQuestion, getDayz129CatalogStats } from '../../src/modules/ai/dayz129Catalog';

describe('DayZ production grounding', () => {
  it('keeps the complete embedded types.xml union available', () => {
    const stats = getDayz129CatalogStats();
    expect(stats.totalTypeNames).toBeGreaterThanOrEqual(1974);
  });

  it.each([
    'Classname Tactical Shirt',
    'Classname Plate Carrier',
    'Classname Hunting Jacket',
  ])('resolves natural full-index type wording without falling back to a tiny alias list: %s', (query) => {
    const result = answerDayz129CatalogQuestion(query);
    expect(result).not.toBeNull();
    expect(result?.topic).toMatch(/^type/);
    expect(result?.answer).not.toContain('keinen eindeutig passenden Classname');
    expect(result?.ids.some(id => id.startsWith('dayz129:type:'))).toBe(true);
  });

  it('continues to refuse dangerously short ambiguous classname guesses', () => {
    const result = answerDayz129CatalogQuestion('Classname AK');
    expect(result).not.toBeNull();
    expect(result?.ids).toContain('dayz129:type:not-found');
  });

  it.each([
    ['Was bedeutet nominal in der DayZ types.xml?', 'Zielbestand'],
    ['Was bedeutet min in der DayZ types.xml?', 'untere'],
    ['Was bedeutet lifetime in der DayZ types.xml?', 'kein Respawn-Timer'],
    ['Was bedeutet restock in der DayZ types.xml?', 'kein fester Countdown'],
    ['Was bedeuten flags in der DayZ types.xml?', 'count_in_cargo'],
  ])('answers core CE semantics deterministically: %s', (question, expected) => {
    const result = answerDayz129CatalogQuestion(question);
    expect(result).not.toBeNull();
    expect(result?.answer).toContain(expected);
    expect(result?.topic).toBe('file');
  });
});
