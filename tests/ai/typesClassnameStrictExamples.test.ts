process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';

describe('strict classname examples', () => {
  it('resolves M4 to M4A1 only', () => {
    const r = answerDayz129CatalogQuestion('kannst du mir den classname von der M4 sagen?');
    expect(r?.answer).toBe('Der Classname ist **`M4A1`**.');
    expect(r?.answer).not.toMatch(/types\.xml|nominal|restock|lifetime/i);
  });

  it('resolves M4 follow-ups', () => {
    expect(answerDayz129CatalogQuestion('von der M4')?.answer).toBe('Der Classname ist **`M4A1`**.');
    expect(answerDayz129CatalogQuestion('ich meine die waffe M4')?.answer).toBe('Der Classname ist **`M4A1`**.');
  });

  it('resolves generic Kampfstiefel to the real TTSKOBoots (official stringtable.csv alias)', () => {
    const text = answerDayz129CatalogQuestion('classname von den Kampfstiefel')?.answer ?? '';
    expect(text).toContain('TTSKOBoots');
    expect(text).not.toMatch(/Headlight|MP5|nominal|restock/i);
  });

  it('returns only requested colours', () => {
    // TTSKOBoots hat keine Farbvarianten - eine erfundene Farbe bleibt fail-closed.
    expect(answerDayz129CatalogQuestion('Classname Kampfstiefel Grün')?.answer).toMatch(/keinen eindeutig passenden Classname/i);
    expect(answerDayz129CatalogQuestion('Classname vom Feldrucksack Grün')?.answer).toBe('Der Classname ist **`AliceBag_Green`**.');
  });

  it('keeps explicit real classnames exact', () => {
    expect(answerDayz129CatalogQuestion('Classname AK101')?.answer).toBe('Der Classname ist **`AK101`**.');
    expect(answerDayz129CatalogQuestion('Classname AK101_Green')?.answer).toBe('Der Classname ist **`AK101_Green`**.');
  });

  it.each([
    ['Seekiste', 'SeaChest'],
    ['Sea Chest', 'SeaChest'],
    ['Generator', 'PowerGenerator'],
    ['Strom-Generator', 'PowerGenerator'],
    ['Militärzelt', 'LargeTent'],
  ])('resolves verified German/English alias %s', (input, expected) => {
    expect(answerDayz129CatalogQuestion(`Classname ${input}`)?.answer)
      .toBe(`Der Classname ist **\`${expected}\`**.`);
  });

  it('normalizes spacing, separators, plurals, umlauts and a bounded typo', () => {
    expect(answerDayz129CatalogQuestion('Classname von den Feldrucksäcken grün')?.answer)
      .toBe('Der Classname ist **`AliceBag_Green`**.');
    expect(answerDayz129CatalogQuestion('Classname Strom_Generatoren')?.answer)
      .toBe('Der Classname ist **`PowerGenerator`**.');
    expect(answerDayz129CatalogQuestion('Classname Kampfstifel')?.answer)
      .toBe('Der Classname ist **`TTSKOBoots`**.');
  });

  it('does not guess short ambiguous weapon families', () => {
    const text = answerDayz129CatalogQuestion('Classname AK')?.answer ?? '';
    expect(text).toMatch(/keinen eindeutig passenden Classname/i);
    expect(text).not.toMatch(/AK101|AK74|AKM/);
  });
});
